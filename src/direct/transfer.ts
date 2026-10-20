import type { EnvelopeEncoder } from "../core/crypto.js";
import { LIMITS } from "./config.js";
import {
  DATA_HEADER_BYTES,
  FrameError,
  decodeFrame,
  encodeAck,
  encodeData,
  encodeEnd,
  encodeKept,
  encodeStop,
  type StopCode,
} from "./frames.js";

/**
 * The file transfer over the data channel (wildbloom-direct/1, "Data channel and
 * frames"): one FSWNENC2 envelope as DATA frames, ACKs from the receiver, one
 * END with the file's SHA-256, and KEPT only after the receiver has verified
 * the lot. Both ends work over an abstract channel, so the whole state machine
 * runs in tests with no browser.
 */

export interface ChannelHandlers {
  /** One binary message. A text message is delivered as an empty one, which is a protocol failure. */
  frame(bytes: Uint8Array): void;
  /** The send buffer has drained to the low-water threshold. */
  low(): void;
  /** The channel closed, for any reason. */
  closed(): void;
}

/** What the transfer needs from an `RTCDataChannel`, so tests and other transports can stand in. */
export interface FrameChannel {
  readonly open: boolean;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  /** The largest message the connection carries (SCTP's `maxMessageSize`); the protocol caps frames at 65,536 either way. */
  readonly maxMessageSize: number;
  send(frame: Uint8Array): void;
  close(): void;
  listen(handlers: ChannelHandlers): () => void;
}

export type TransferFailure =
  /** This end stopped it. */
  | "cancelled"
  /** The other end sent STOP 1. */
  | "peer-cancelled"
  /** The other end sent STOP 2. */
  | "peer-failed"
  /** The other end sent STOP 3: it has no room. */
  | "peer-storage"
  /** A frame that is not allowed arrived, and STOP 2 went out. */
  | "protocol"
  /** The channel closed before the transfer finished. */
  | "closed"
  /** The connection's messages are too small for the protocol (under 16,384 bytes). */
  | "frame-size"
  /** The sender could not read its file. */
  | "source"
  /** The receiver's sink refused the file after END. */
  | "verification"
  /** The receiver's sink ran out of room. */
  | "storage";

export class TransferError extends Error {
  readonly kind: TransferFailure;
  constructor(kind: TransferFailure, message?: string) {
    super(message ?? kind);
    this.name = "TransferError";
    this.kind = kind;
  }
}

/** A sink throws this when it has no room, so the receiver sends STOP 3 instead of STOP 2. */
export class SinkStorageError extends Error {
  constructor(message = "There is no room to keep the file.") {
    super(message);
    this.name = "SinkStorageError";
  }
}

const STOP_FOR: Readonly<Record<"peer-cancelled" | "peer-failed" | "peer-storage", TransferFailure>> = {
  "peer-cancelled": "peer-cancelled",
  "peer-failed": "peer-failed",
  "peer-storage": "peer-storage",
};
const failureForStop = (code: StopCode): TransferFailure => STOP_FOR[code === 1 ? "peer-cancelled" : code === 3 ? "peer-storage" : "peer-failed"];

/** A wait that anything can end: callers poke it after changing state. */
function createWaiter(): {
  poke(): void;
  wait(timeoutMs?: number): Promise<void>;
  until(ready: () => boolean, failure: () => Error | undefined): Promise<void>;
} {
  let wake: (() => void) | undefined;
  const wait = (timeoutMs?: number): Promise<void> => new Promise<void>((resolve) => {
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => { wake = undefined; resolve(); }, timeoutMs);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return {
    poke(): void {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    },
    wait,
    async until(ready, failure): Promise<void> {
      for (;;) {
        const error = failure();
        if (error) throw error;
        if (ready()) return;
        await wait();
      }
    },
  };
}

/** What the sender knows when it asks how much it may put on the wire. */
export interface PacingState {
  /** Envelope bytes sent and not yet acknowledged. */
  readonly inFlight: number;
  /** Bytes in the channel's send buffer. */
  readonly buffered: number;
  /** The send buffer passed the high-water mark and has not yet drained to the low-water mark. */
  readonly paused: boolean;
  /** Envelope bytes sent so far, in all. A rule that spends a budget learns what was spent from the change in this. */
  readonly sent: number;
  /** What the next frame would carry if nothing held it back: at most one frame's payload. */
  readonly wanted: number;
}

/**
 * The sender's pacing, kept apart from the frame logic so a rule can be added
 * or changed without touching it. It says how many bytes may be sent now, and
 * when to ask again if the answer is none and nothing else (an ACK, the buffer
 * draining) will prompt a new look.
 */
export type Pacing = (state: PacingState) => { readonly bytes: number; readonly retryMs?: number };

/** The protocol's rules: at most 8 MiB beyond the last ACK, and nothing while the send buffer is over its high-water mark. */
export const protocolPacing: Pacing = ({ inFlight, paused }) => ({
  bytes: paused ? 0 : Math.max(0, LIMITS.unacknowledgedBytes - inFlight),
});

function trySend(channel: FrameChannel, frame: Uint8Array): void {
  try {
    if (channel.open) channel.send(frame);
  } catch {
    // The channel is going away; there is nobody to tell.
  }
}

// ------------------------------------------------------------------- sender

export interface SendEnvelopeOptions {
  readonly channel: FrameChannel;
  readonly encoder: EnvelopeEncoder;
  /** Called with the bytes the receiver has acknowledged (never bytes merely queued) and the envelope length. */
  readonly onProgress?: (acknowledged: number, total: number) => void;
  readonly signal?: AbortSignal;
  /** How much may be sent now. Defaults to `protocolPacing`; a stricter rule may be supplied, never a looser one. */
  readonly pacing?: Pacing;
}

/**
 * Sends the encoder's envelope and resolves only when the receiver says KEPT.
 * It keeps at most 8 MiB beyond the last ACK in flight, pauses while the send
 * buffer holds over 1 MiB and resumes when the buffer drains to 256 KiB, so the
 * page holds a few records whatever the file size. Rejects with a
 * `TransferError`.
 */
export async function sendEnvelope(options: SendEnvelopeOptions): Promise<void> {
  const { channel, encoder, onProgress, signal } = options;
  const pacing = options.pacing ?? protocolPacing;
  const total = encoder.envelopeBytes;
  const frameSize = Math.min(channel.maxMessageSize, LIMITS.frameBytes);
  const waiter = createWaiter();
  let sent = 0;
  let acknowledged = 0;
  let ended = false;
  let kept = false;
  let paused = false;
  let failure: TransferError | undefined;
  const fail = (error: TransferError, stopCode?: StopCode): void => {
    if (failure) return;
    failure = error;
    if (stopCode !== undefined) trySend(channel, encodeStop(stopCode));
    waiter.poke();
  };

  const stopListening = channel.listen({
    frame(bytes): void {
      if (failure || kept) return;
      let frame;
      try {
        frame = decodeFrame("receiver", bytes);
      } catch (error) {
        fail(new TransferError("protocol", error instanceof FrameError ? error.message : "A bad frame."), 2);
        return;
      }
      switch (frame.type) {
        case "ack":
          if (frame.next <= acknowledged || frame.next > sent) {
            fail(new TransferError("protocol", "An ACK that does not move forward within what was sent."), 2);
            return;
          }
          acknowledged = frame.next;
          onProgress?.(acknowledged, total);
          break;
        case "kept":
          if (!ended) {
            fail(new TransferError("protocol", "KEPT before END."), 2);
            return;
          }
          kept = true;
          break;
        case "stop":
          fail(new TransferError(failureForStop(frame.code)));
          return;
        default:
          fail(new TransferError("protocol", "A frame the sender does not read."), 2);
          return;
      }
      waiter.poke();
    },
    low(): void {
      paused = false;
      waiter.poke();
    },
    closed(): void {
      if (!kept) fail(new TransferError("closed"));
    },
  });
  const onAbort = (): void => fail(new TransferError("cancelled"), 1);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal?.aborted) onAbort();
    if (!channel.open) fail(new TransferError("closed"));
    if (frameSize < LIMITS.minFrameBytes) fail(new TransferError("frame-size"), 2);
    if (failure) throw failure;
    channel.bufferedAmountLowThreshold = LIMITS.lowWaterBytes;
    onProgress?.(0, total);

    const room = frameSize - DATA_HEADER_BYTES;
    let current: Uint8Array = encoder.header;
    let position = 0;
    let upcoming: Promise<Uint8Array | undefined> | undefined;
    const prefetch = (): void => {
      if (upcoming === undefined) {
        upcoming = encoder.next();
        // Reported when it is awaited; this keeps a rejection from being unhandled before then.
        upcoming.catch(() => undefined);
      }
    };
    prefetch();

    while (sent < total) {
      if (position === current.length) {
        let record: Uint8Array | undefined;
        try {
          record = await upcoming;
        } catch (error) {
          if (failure) throw failure;
          const cancelled = signal?.aborted === true;
          fail(new TransferError(cancelled ? "cancelled" : "source", error instanceof Error ? error.message : "The file could not be read."), cancelled ? 1 : 2);
          throw failure;
        }
        upcoming = undefined;
        if (!record) {
          fail(new TransferError("source", "The envelope ended early."), 2);
          throw failure!;
        }
        current = record;
        position = 0;
        prefetch();
      }
      if (failure) throw failure;
      // What would go in the next frame if nothing held it back.
      const wanted = Math.min(room, current.length - position, total - sent);
      // Ask the pacing rule; if it says none, wait for an ACK, the buffer to drain, or its own retry time.
      let allowed = 0;
      for (;;) {
        if (failure) throw failure;
        const verdict = pacing({ inFlight: sent - acknowledged, buffered: channel.bufferedAmount, paused, sent, wanted });
        // The protocol's own window is a ceiling no pacing rule can lift.
        allowed = Math.min(verdict.bytes, LIMITS.unacknowledgedBytes - (sent - acknowledged));
        if (allowed > 0) break;
        await waiter.wait(verdict.retryMs);
      }
      if (failure) throw failure;
      const take = Math.min(wanted, allowed);
      try {
        channel.send(encodeData(sent, current.subarray(position, position + take)));
      } catch {
        fail(new TransferError("closed"));
        throw failure!;
      }
      sent += take;
      position += take;
      if (channel.bufferedAmount > LIMITS.highWaterBytes) paused = true;
    }

    trySend(channel, encodeEnd(encoder.digest(), encoder.metadata.size));
    ended = true;
    await waiter.until(() => kept, () => failure);
  } finally {
    stopListening();
    signal?.removeEventListener("abort", onAbort);
  }
}

// ----------------------------------------------------------------- receiver

/**
 * Where a receiver puts the envelope. Drop's sink writes a private temporary
 * file and, on `end`, has the Rust reader authenticate every record; a
 * browser's sink keeps the bytes and opens them with the page's own reader.
 * The sink owns verification: the transfer never touches plaintext.
 */
export interface DirectSink {
  /** The next envelope bytes, strictly in order from offset 0. The ACK for them follows when this resolves. */
  write(bytes: Uint8Array): Promise<void>;
  /**
   * Every byte has arrived and END has been read. Authenticate the envelope, check its
   * record count and padding against its header, its metadata against the manifest, and its
   * plaintext size and SHA-256 against `end`; then keep the file and resolve. Reject to refuse
   * it. Nothing may be savable before this resolves.
   */
  end(end: { readonly sha256: Uint8Array; readonly size: number }): Promise<void>;
  /** Delete anything held. Called on every failure, stop and close; safe to repeat. */
  abort(): Promise<void>;
}

export interface ReceiveEnvelopeOptions {
  readonly channel: FrameChannel;
  /** The envelope length, from the manifest. */
  readonly envelopeBytes: number;
  /** The file's plaintext size, from the manifest; END must repeat it. */
  readonly plaintextBytes: number;
  readonly sink: DirectSink;
  /** Called with the bytes the sink has written and the envelope length. */
  readonly onProgress?: (written: number, total: number) => void;
  readonly signal?: AbortSignal;
}

/**
 * Receives the envelope into the sink and resolves after it has sent KEPT.
 * Anything out of order, past the end or after END is a failure: STOP 2, the
 * sink is aborted, and it rejects with a `TransferError`.
 */
export async function receiveEnvelope(options: ReceiveEnvelopeOptions): Promise<void> {
  const { channel, sink, onProgress, signal } = options;
  const total = options.envelopeBytes;
  const waiter = createWaiter();
  let received = 0;
  let written = 0;
  let lastAck = 0;
  let endSeen = false;
  let done = false;
  let failure: TransferError | undefined;
  let queue: Promise<void> = Promise.resolve();
  const fail = (error: TransferError, stopCode?: StopCode): void => {
    if (failure || done) return;
    failure = error;
    if (stopCode !== undefined) trySend(channel, encodeStop(stopCode));
    waiter.poke();
  };
  const sendOrThrow = (frame: Uint8Array): void => {
    try {
      channel.send(frame);
    } catch {
      throw new TransferError("closed");
    }
  };
  // Work on the sink runs one step at a time, in arrival order.
  const enqueue = (step: () => Promise<void>): void => {
    queue = queue.then(async () => {
      if (failure) return;
      try {
        await step();
      } catch (error) {
        if (error instanceof TransferError) fail(error);
        else if (error instanceof SinkStorageError) fail(new TransferError("storage", error.message), 3);
        else fail(new TransferError("verification", error instanceof Error ? error.message : "The sink refused the file."), 2);
      }
      waiter.poke();
    });
  };

  const stopListening = channel.listen({
    frame(bytes): void {
      if (failure || done) return;
      let frame;
      try {
        frame = decodeFrame("sender", bytes);
      } catch (error) {
        fail(new TransferError("protocol", error instanceof FrameError ? error.message : "A bad frame."), 2);
        return;
      }
      switch (frame.type) {
        case "data": {
          const length = frame.bytes.length;
          if (endSeen) return fail(new TransferError("protocol", "DATA after END."), 2);
          if (frame.offset !== received) return fail(new TransferError("protocol", "DATA that leaves a gap or an overlap."), 2);
          if (received + length > total) return fail(new TransferError("protocol", "DATA past the end of the envelope."), 2);
          if (received + length - lastAck > LIMITS.unacknowledgedBytes) return fail(new TransferError("protocol", "More than 8 MiB beyond the last ACK."), 2);
          received += length;
          const chunk = frame.bytes;
          enqueue(async () => {
            await sink.write(chunk);
            written += length;
            if (written - lastAck >= LIMITS.ackEveryBytes || written === total) {
              lastAck = written;
              sendOrThrow(encodeAck(written));
            }
            onProgress?.(written, total);
          });
          break;
        }
        case "end": {
          if (endSeen) return fail(new TransferError("protocol", "A second END."), 2);
          if (received !== total) return fail(new TransferError("protocol", "END before every byte arrived."), 2);
          if (frame.size !== options.plaintextBytes) return fail(new TransferError("verification", "END names a different size from the manifest."), 2);
          endSeen = true;
          const end = { sha256: frame.sha256, size: frame.size };
          enqueue(async () => {
            await sink.end(end);
            sendOrThrow(encodeKept());
            done = true;
          });
          break;
        }
        case "stop":
          fail(new TransferError(failureForStop(frame.code)));
          return;
        default:
          fail(new TransferError("protocol", "A frame the receiver does not read."), 2);
          return;
      }
    },
    low(): void {
      // The receiver only sends ACKs, which are tiny.
    },
    closed(): void {
      if (!done) fail(new TransferError("closed"));
    },
  });
  const onAbort = (): void => fail(new TransferError("cancelled"), 1);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal?.aborted) onAbort();
    if (!channel.open) fail(new TransferError("closed"));
    // A zero-length envelope cannot occur (the header alone is 56 bytes), so END always follows DATA.
    await waiter.until(() => done, () => failure);
  } catch (error) {
    // Whatever was held is deleted on every way out but a kept file, once the step in flight has settled.
    await queue;
    await sink.abort().catch(() => undefined);
    throw error;
  } finally {
    stopListening();
    signal?.removeEventListener("abort", onAbort);
  }
}
