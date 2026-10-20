import { createEnvelopeEncoder, envelopeBytes, newInputKey } from "../core/crypto.js";
import { classifyPairingFailure } from "../get/failure.js";
import { CONNECT_GIVE_UP_MS, LIMITS, RECONNECT_GIVE_UP_MS } from "./config.js";
import {
  decodeMessage,
  encodeMessage,
  type DirectMessage,
  type IceServer,
  type Invite,
  type Manifest,
  type Side,
  type StopReason,
} from "./messages.js";
import { FRAME_TYPE } from "./frames.js";
import { createPathPacing, stricter, watchPath, type PathWatch, type PathWatchOptions, type RatePacerOptions } from "./pacing.js";
import { DirectPeer, NoRelayError, type PeerOptions, type PeerState } from "./peer.js";
import { receiveEnvelope, sendEnvelope, TransferError, type DirectSink, type FrameChannel, type Pacing } from "./transfer.js";

/**
 * The two ends of a direct send over a word-verified exchange
 * (wildbloom-direct/1, "Session" to "Reconnection and the deadline"). The page
 * is the sender and Drop the receiver in `to-drop`; Drop always makes the
 * WebRTC offer and the ICE restarts.
 *
 * A session owns its exchange and its peer connection and closes both when it
 * ends. Every failure is a `DirectError` with a kind the screens can speak
 * plainly about.
 */

export type DirectFailure =
  /** This end stopped it. */
  | "cancelled"
  /** The other end stopped it. */
  | "peer-cancelled"
  /** Drop declined the file. */
  | "declined"
  /** This end cannot use what was offered (a version, direction, ICE server or size); the other end was told. */
  | "unsupported"
  /** The other end said it cannot use what this end sent. */
  | "peer-unsupported"
  /** A message or frame the protocol does not allow; the other end was told. */
  | "protocol"
  /** The other end said it failed. */
  | "peer-failed"
  /** The other end has no room to keep the file. */
  | "peer-storage"
  /** Hiding was asked for but there is no TURN server to hide behind. */
  | "no-relay"
  /** The two ends never connected. */
  | "connect"
  /** The connection was lost and there was no way back before the limit or the session deadline. */
  | "lost"
  /** The session deadline passed before this step. */
  | "expired"
  /** The exchange failed in the network. */
  | "network"
  /** The file could not be read. */
  | "source"
  /** The file is larger than the receiver allows. */
  | "too-big"
  /** This receiver's sink refused the file after END. */
  | "verification"
  /** This receiver's sink had no room. */
  | "storage";

export class DirectError extends Error {
  readonly kind: DirectFailure;
  constructor(kind: DirectFailure, message?: string, options?: { cause?: unknown }) {
    super(message ?? kind, options);
    this.name = "DirectError";
    this.kind = kind;
  }
}

/** What a session needs from the foregather-exchange/1 channel (the kit's `PairingExchange` fits through `fromPairingExchange`). */
export interface MessageExchange {
  send(payload: Uint8Array): Promise<void>;
  receive(): Promise<Uint8Array>;
  close(): void;
}

interface KitExchange {
  send(input: { payload: Uint8Array }): Promise<void>;
  receive(): Promise<Uint8Array>;
  close(): void;
}

export function fromPairingExchange(exchange: KitExchange): MessageExchange {
  return {
    send: (payload) => exchange.send({ payload }),
    receive: () => exchange.receive(),
    close: () => exchange.close(),
  };
}

/** What a session needs from a peer connection, so tests can stand in for the browser. */
export interface PeerLike {
  readonly channel: Promise<FrameChannel>;
  readonly state: PeerState;
  offer(restart?: boolean): Promise<string>;
  answer(offerSdp: string): Promise<string>;
  applyAnswer(answerSdp: string): Promise<void>;
  /** Whether the selected candidate pair has a relay candidate at either end; undefined while none is selected. */
  relayed(): Promise<boolean | undefined>;
  onState(listener: (state: PeerState, violation: boolean) => void): () => void;
  close(): void;
}
export type PeerFactory = (options: PeerOptions) => PeerLike;
const browserPeer: PeerFactory = (options) => new DirectPeer(options);

// -------------------------------------------------------------------- helpers

function exchangeFailure(error: unknown): DirectError {
  if (error instanceof DirectError) return error;
  const kind = classifyPairingFailure(error, true);
  if (kind === "expired") return new DirectError("expired", "The session ended.", { cause: error });
  if (kind === "cancelled") return new DirectError("cancelled", "The exchange was cancelled.", { cause: error });
  return new DirectError("network", "The exchange failed.", { cause: error });
}

function failureForPeerStop(reason: StopReason): DirectFailure {
  return reason === "cancelled" ? "peer-cancelled" : reason === "unsupported" ? "peer-unsupported" : "peer-failed";
}

function failureForTransfer(error: unknown): DirectError {
  if (error instanceof DirectError) return error;
  if (!(error instanceof TransferError)) return new DirectError("protocol", error instanceof Error ? error.message : "A failure.", { cause: error });
  switch (error.kind) {
    case "cancelled": return new DirectError("cancelled");
    case "peer-cancelled": return new DirectError("peer-cancelled");
    case "peer-failed": return new DirectError("peer-failed");
    case "peer-storage": return new DirectError("peer-storage");
    case "protocol": return new DirectError("protocol", error.message);
    case "closed": return new DirectError("lost", "The connection closed.");
    case "frame-size": return new DirectError("unsupported", "The connection cannot carry messages this size.");
    case "source": return new DirectError("source", error.message);
    case "verification": return new DirectError("verification", error.message);
    case "storage": return new DirectError("storage", error.message);
  }
}

/** One end of the exchange: counts indexes, keeps sends in order and sends `stop` at most once. */
class Link {
  private sentCount = 0;
  private receivedCount = 0;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private ended = false;

  constructor(
    private readonly exchange: MessageExchange,
    private readonly us: Side,
    private readonly iceAllowlist: readonly string[],
  ) {}

  get sent(): number {
    return this.sentCount;
  }
  get received(): number {
    return this.receivedCount;
  }
  get isOpen(): boolean {
    return !this.ended;
  }

  /** Sends the next message and returns the index it took. */
  send(message: DirectMessage): Promise<number> {
    if (this.ended) return Promise.reject(new DirectError("expired", "The exchange has ended."));
    // After a stop, from either end, nothing more is sent.
    if (this.stopped && message.event !== "stop") return Promise.reject(new DirectError("cancelled", "The exchange has been stopped."));
    if (this.sentCount >= LIMITS.messagesPerSide) return Promise.reject(new DirectError("protocol", "No messages left."));
    const bytes = encodeMessage(message);
    const index = this.sentCount;
    this.sentCount += 1;
    const turn = this.chain.then(() => this.exchange.send(bytes));
    this.chain = turn.catch(() => undefined);
    return turn.then(() => index, (error: unknown) => { throw exchangeFailure(error); });
  }

  /** Reads and decodes the next message. A message that is not allowed is answered with `stop` and thrown. */
  async read(options: { max?: number } = {}): Promise<{ message: DirectMessage; index: number }> {
    let bytes: Uint8Array;
    try {
      bytes = await this.exchange.receive();
    } catch (error) {
      throw exchangeFailure(error);
    }
    const index = this.receivedCount;
    this.receivedCount += 1;
    const decoded = decodeMessage(bytes, {
      from: this.us === "page" ? "drop" : "page",
      index,
      iceAllowlist: this.iceAllowlist,
      ...(options.max === undefined ? {} : { max: options.max }),
    });
    if (!decoded.ok) {
      await this.stop(decoded.stop).catch(() => undefined);
      throw new DirectError(decoded.stop === "unsupported" ? "unsupported" : "protocol", decoded.detail);
    }
    if (decoded.message.event === "stop") this.stopped = true;
    return { message: decoded.message, index };
  }

  /** Best effort and at most once: a `stop` message in place of the next one. */
  async stop(reason: StopReason): Promise<void> {
    if (this.stopped || this.ended || this.sentCount >= LIMITS.messagesPerSide) return;
    this.stopped = true;
    await this.send({ event: "stop", reason });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.exchange.close();
  }
}

interface Watch {
  /** Rejects when the connection could not be found or restored. */
  readonly failed: Promise<never>;
  /** Gives up now. */
  giveUp(): void;
  /** The state as the watcher last saw it. */
  evaluate(): void;
  stop(): void;
}

interface WatchOptions {
  readonly connectMs: number;
  readonly reconnectMs: number;
  /** The connection dropped (true) or came back (false) after it had been up. */
  readonly onReconnecting?: ((on: boolean) => void) | undefined;
  /** Every state change, after the watcher has dealt with it. */
  readonly onState?: ((state: PeerState) => void) | undefined;
  /** Called when the watcher gives up, with the error `failed` rejects with. */
  readonly onGiveUp: (error: DirectError) => DirectError;
}

/**
 * Watches the peer connection. The end of a transfer is driven by the
 * connection state, not by the data channel's close event alone: some browsers
 * never fire it when the other end vanishes. `disconnected` is only a note to
 * the person; `failed` starts a clock, and a connection that never came up at
 * all has its own.
 */
function watchConnection(peer: PeerLike, options: WatchOptions): Watch {
  let rejectFailed!: (error: DirectError) => void;
  const failed = new Promise<never>((_resolve, reject) => { rejectFailed = reject; });
  failed.catch(() => undefined);
  let everConnected = false;
  let down = false;
  let stopped = false;
  let failedTimer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = (): void => {
    if (stopped) return;
    rejectFailed(options.onGiveUp(new DirectError(everConnected ? "lost" : "connect", "The connection could not be restored.")));
  };
  let connectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(giveUp, options.connectMs);
  const evaluate = (): void => {
    if (stopped) return;
    const state = peer.state;
    if (state === "connected") {
      everConnected = true;
      clearTimeout(connectTimer);
      connectTimer = undefined;
      clearTimeout(failedTimer);
      failedTimer = undefined;
      if (down) options.onReconnecting?.(false);
      down = false;
    } else if (state === "disconnected" || state === "failed") {
      if (everConnected && !down) options.onReconnecting?.(true);
      down = true;
      if (state === "failed") failedTimer ??= setTimeout(giveUp, options.reconnectMs);
    } else if (state === "closed") {
      clearTimeout(connectTimer);
      clearTimeout(failedTimer);
    }
    options.onState?.(state);
  };
  const stopListening = peer.onState(() => evaluate());
  evaluate();
  return {
    failed,
    giveUp,
    evaluate,
    stop(): void {
      stopped = true;
      clearTimeout(connectTimer);
      clearTimeout(failedTimer);
      stopListening();
    },
  };
}

// ------------------------------------------------------------ the sending end

export interface SenderSessionOptions {
  readonly exchange: MessageExchange;
  /** The page's build-time ICE allowlist. */
  readonly iceAllowlist: readonly string[];
  readonly createPeer?: PeerFactory;
  /** How long the first connection may take. */
  readonly connectMs?: number;
  /** How long a failed connection gets to come back. */
  readonly giveUpMs?: number;
  /** Overrides the relayed-send rate, burst or clock; tests use it. */
  readonly rate?: RatePacerOptions;
  /** Overrides how the selected pair is re-read; tests use it. */
  readonly pathWatch?: PathWatchOptions;
}

export interface SendHooks {
  /** Hide this device's own address behind the TURN server. */
  readonly hide: boolean;
  /** The answer has gone out and the two ends are finding a path. */
  readonly onConnecting?: () => void;
  /** The data channel is open and the file starts to move. */
  readonly onConnected?: () => void;
  /** The bytes the receiver has acknowledged, and the envelope length. */
  readonly onProgress?: (acknowledged: number, total: number) => void;
  /**
   * The end marker has left: every byte is sent, and the receiver may already be keeping the file. From here on the
   * only ending that says it arrived is the receiver's own "kept"; any other ending cannot say it did not.
   */
  readonly onEndSent?: () => void;
  /** The connection dropped (true) or came back (false). */
  readonly onReconnecting?: (on: boolean) => void;
  /** A stricter pacing rule than the protocol's and the relay's, if one is wanted. */
  readonly pacing?: Pacing;
  /** The selected pair is relayed (so the send is paced) or direct. Called when that answer changes. */
  readonly onPath?: (relayed: boolean | undefined) => void;
}

export interface ManifestInput {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

/**
 * The channel, telling `onEnd` once the end marker has been handed to it. The sender's own code is not asked to
 * report this, so the transfer module stays as it is.
 */
function announceEnd(channel: FrameChannel, onEnd: () => void): FrameChannel {
  return {
    get open(): boolean { return channel.open; },
    get bufferedAmount(): number { return channel.bufferedAmount; },
    get bufferedAmountLowThreshold(): number { return channel.bufferedAmountLowThreshold; },
    set bufferedAmountLowThreshold(value: number) { channel.bufferedAmountLowThreshold = value; },
    get maxMessageSize(): number { return channel.maxMessageSize; },
    send(frame: Uint8Array): void {
      channel.send(frame);
      if (frame[0] === FRAME_TYPE.end) onEnd();
    },
    close: () => channel.close(),
    listen: (handlers) => channel.listen(handlers),
  };
}

/** How long a deliberate stop waits for its last words to leave before everything closes. */
const FLUSH_MS = 250;

/**
 * Waits for the channel's send buffer to empty, up to `limitMs`. Closing a
 * peer connection discards what it has not sent, so a last frame (KEPT, or a
 * STOP) must leave before the connection closes.
 */
async function drained(channel: FrameChannel | undefined, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (channel?.open && channel.bufferedAmount > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The page's end: read the invitation, offer a manifest, and once Drop accepts,
 * answer its offer and send the file. Call `readInvite`, `offer` and `send` in
 * that order; `stop` ends it from anywhere.
 */
export class SenderSession {
  private readonly link: Link;
  private readonly createPeer: PeerFactory;
  private readonly connectMs: number;
  private readonly giveUpMs: number;
  private readonly rate: RatePacerOptions;
  private readonly pathOptions: PathWatchOptions;
  private path: PathWatch | undefined;
  private invite: Invite | undefined;
  private manifest: ManifestInput | undefined;
  private offerSdp: string | undefined;
  private peer: PeerLike | undefined;
  private channel: FrameChannel | undefined;
  private run: AbortController | undefined;
  private failure: DirectError | undefined;
  private watch: Watch | undefined;
  private restartsPossible = true;
  private finished = false;

  constructor(options: SenderSessionOptions) {
    this.link = new Link(options.exchange, "page", options.iceAllowlist);
    this.createPeer = options.createPeer ?? browserPeer;
    this.connectMs = options.connectMs ?? CONNECT_GIVE_UP_MS;
    this.giveUpMs = options.giveUpMs ?? RECONNECT_GIVE_UP_MS;
    this.rate = options.rate ?? {};
    this.pathOptions = options.pathWatch ?? {};
  }

  /** Reads Drop's invitation (message 0). Throws `unsupported` or `protocol` after telling Drop. */
  async readInvite(): Promise<Invite> {
    try {
      const { message } = await this.link.read();
      if (message.event !== "invite") throw new DirectError("protocol", "The first message was not an invitation.");
      this.invite = message;
      return message;
    } catch (error) {
      throw this.end(error);
    }
  }

  /**
   * Offers the file's manifest (message 0) and waits for Drop's answer. Resolves
   * "declined" when the owner says no, which ends the session; "accepted" keeps
   * Drop's offer for `send`.
   */
  async offer(manifest: ManifestInput): Promise<"accepted" | "declined"> {
    const invite = this.invite;
    if (!invite) throw new DirectError("protocol", "There is no invitation yet.");
    if (manifest.size > invite.max) throw this.end(new DirectError("too-big", "The file is larger than the receiver allows."));
    try {
      this.manifest = manifest;
      await this.link.send({ event: "manifest", ...manifest });
      const { message } = await this.link.read();
      if (message.event === "decline") {
        this.link.end();
        return "declined";
      }
      if (message.event === "stop") throw new DirectError(failureForPeerStop(message.reason));
      if (message.event !== "accept") throw new DirectError("protocol", "Expected an accept or a decline.");
      this.offerSdp = message.sdp;
      return "accepted";
    } catch (error) {
      throw this.end(error);
    }
  }

  /**
   * Answers the accepted offer and sends the file. Resolves only after Drop
   * says KEPT. Reconnection is Drop's to start: each ICE restart arrives as a
   * message here and is answered on the same connection.
   */
  async send(file: Blob, hooks: SendHooks): Promise<void> {
    const { invite, manifest, offerSdp } = this;
    if (!invite || !manifest || offerSdp === undefined) throw new DirectError("protocol", "The file has not been accepted.");
    const run = new AbortController();
    this.run = run;
    let encoder: Awaited<ReturnType<typeof createEnvelopeEncoder>> | undefined;
    try {
      encoder = await createEnvelopeEncoder(file, { name: manifest.name, type: manifest.type }, { key: newInputKey(), signal: run.signal });
      if (encoder.metadata.name !== manifest.name || encoder.metadata.type !== manifest.type || file.size !== manifest.size) {
        throw new DirectError("source", "The file does not match its manifest.");
      }
      let peer: PeerLike;
      try {
        peer = this.createPeer({ iceServers: invite.ice, hide: hooks.hide });
      } catch (error) {
        throw error instanceof NoRelayError ? new DirectError("no-relay") : error;
      }
      this.peer = peer;
      // A relayed pair is paced; the pair is read once connected and again after each ICE restart.
      const pathPacing = createPathPacing(this.rate);
      let reported: boolean | undefined;
      const path = watchPath(() => peer.relayed(), (relayed) => {
        pathPacing.setRelayed(relayed);
        // Tell the page when the answer changes, not each time the pair is read again.
        if (relayed !== reported) {
          reported = relayed;
          hooks.onPath?.(relayed);
        }
      }, this.pathOptions);
      this.path = path;
      const watch = watchConnection(peer, {
        connectMs: this.connectMs,
        reconnectMs: this.giveUpMs,
        onReconnecting: hooks.onReconnecting,
        onGiveUp: (error) => this.giveUp(error),
        // Coming back after a drop may be on another path.
        onState: (state) => { if (state === "connected") void path.refresh(); },
      });
      this.watch = watch;
      const answerSdp = await peer.answer(offerSdp);
      await this.link.send({ event: "answer", key: encoder.inputKey, sdp: answerSdp });
      hooks.onConnecting?.();
      void this.answerRestarts(peer);

      const channel = await Promise.race([peer.channel, watch.failed]);
      this.channel = channel;
      // Know the path before the first byte, so a relayed send never starts unpaced.
      await Promise.race([path.refresh(), watch.failed]);
      hooks.onConnected?.();
      await Promise.race([
        sendEnvelope({
          channel: hooks.onEndSent ? announceEnd(channel, hooks.onEndSent) : channel,
          encoder,
          signal: run.signal,
          ...(hooks.onProgress ? { onProgress: hooks.onProgress } : {}),
          pacing: hooks.pacing ? stricter(pathPacing.pacing, hooks.pacing) : pathPacing.pacing,
        }),
        watch.failed,
      ]);
      this.finished = true;
    } catch (error) {
      throw this.end(this.failure ?? error);
    } finally {
      this.watch?.stop();
      this.path?.stop();
      encoder?.dispose();
      await drained(this.channel, FLUSH_MS * 4);
      this.close();
    }
  }

  /**
   * Ends the session now: STOP on the channel, `stop` on the exchange, and the
   * connection closed so the other end learns at once. A deliberate stop gives
   * those a moment to leave first; `immediate` (a page being hidden) does not.
   * Safe to repeat.
   */
  stop(reason: Exclude<StopReason, "unsupported"> = "cancelled", options: { immediate?: boolean } = {}): void {
    if (this.finished) return;
    this.failure ??= new DirectError(reason === "cancelled" ? "cancelled" : "protocol");
    this.run?.abort();
    const told = this.link.stop(reason).catch(() => undefined);
    if (options.immediate) this.close();
    else void Promise.race([told, drained(this.channel, FLUSH_MS)]).finally(() => this.close());
  }

  /** Closes the peer and the exchange without telling anyone. */
  close(): void {
    this.peer?.close();
    this.link.end();
  }

  /** The connection could not be found or restored: record why, and close so anything still waiting ends. */
  private giveUp(error: DirectError): DirectError {
    this.failure ??= error;
    this.close();
    return this.failure;
  }

  private end(error: unknown): DirectError {
    const failure = error instanceof DirectError ? error : failureForTransfer(error);
    if (failure.kind === "cancelled" || failure.kind === "too-big") void this.link.stop("cancelled").catch(() => undefined);
    else if (failure.kind === "protocol" || failure.kind === "source" || failure.kind === "lost") void this.link.stop("failed").catch(() => undefined);
    return failure;
  }

  /** Reads Drop's restart offers for as long as the exchange lasts, and answers each. */
  private async answerRestarts(peer: PeerLike): Promise<void> {
    for (;;) {
      let incoming;
      try {
        incoming = await this.link.read();
      } catch (error) {
        const failure = exchangeFailure(error);
        // The deadline or a closed exchange only means no more restarts, unless it was a protocol failure.
        if (failure.kind === "protocol" || failure.kind === "unsupported") this.fail(failure);
        else this.noMoreRestarts();
        return;
      }
      const { message, index } = incoming;
      if (message.event === "stop") {
        this.fail(new DirectError(failureForPeerStop(message.reason)));
        return;
      }
      if (message.event !== "restart" || index !== this.link.sent) {
        await this.link.stop("failed").catch(() => undefined);
        this.fail(new DirectError("protocol", "A restart at the wrong index."));
        return;
      }
      try {
        const sdp = await peer.answer(message.sdp);
        await this.link.send({ event: "restart-answer", sdp });
        // The restart may have moved the send to another pair.
        this.path?.afterRestart();
      } catch (error) {
        const failure = exchangeFailure(error);
        if (failure.kind === "network" || failure.kind === "expired") this.noMoreRestarts();
        else this.fail(failure);
        return;
      }
    }
  }

  private noMoreRestarts(): void {
    this.restartsPossible = false;
    // With no restart to wait for, a failed connection is an ended one.
    if (this.peer?.state === "failed") this.watch?.giveUp();
  }

  private fail(error: DirectError): void {
    this.failure ??= error;
    this.watch?.giveUp();
    this.run?.abort();
    this.peer?.close();
  }
}

// ---------------------------------------------------------- the receiving end

export interface ReceiverSessionOptions {
  readonly exchange: MessageExchange;
  readonly createPeer?: PeerFactory;
  /** How long the first connection may take. */
  readonly connectMs?: number;
  /** How long a failed connection gets to come back. */
  readonly giveUpMs?: number;
  /** How long a connection may stay `disconnected` before Drop restarts ICE. `failed` restarts at once. */
  readonly restartAfterMs?: number;
  /** Overrides how long a description waits for gathering. */
  readonly gatherMs?: number;
}

export interface ReceiveHooks {
  /** Drop's own ICE servers and credential: the same servers as the invitation, a credential of its own. */
  readonly iceServers: readonly IceServer[];
  /** Hide Drop's address behind the TURN server. It must match the invitation's `hide`. */
  readonly hide: boolean;
  /** Makes the sink once the key is known. */
  readonly createSink: (transfer: { readonly manifest: ManifestInput; readonly key: string; readonly envelopeBytes: number }) => DirectSink | Promise<DirectSink>;
  readonly onConnecting?: () => void;
  readonly onConnected?: () => void;
  /** The bytes the sink has written, and the envelope length. */
  readonly onProgress?: (written: number, total: number) => void;
  readonly onReconnecting?: (on: boolean) => void;
}

/**
 * Drop's end, in TypeScript: for the test receiver today, and for any
 * receiver hosted in a browser later. Drop itself does the pairing in Rust
 * and uses `DirectPeer` and `receiveEnvelope` through its webview; the message
 * rules are the same.
 */
export class ReceiverSession {
  private readonly link: Link;
  private readonly createPeer: PeerFactory;
  private readonly connectMs: number;
  private readonly giveUpMs: number;
  private readonly restartAfterMs: number;
  private readonly gatherMs: number | undefined;
  private invite: Invite | undefined;
  private manifest: Manifest | undefined;
  private peer: PeerLike | undefined;
  private channel: FrameChannel | undefined;
  private run: AbortController | undefined;
  private failure: DirectError | undefined;
  private watch: Watch | undefined;
  private finished = false;
  private restartsUsed = 0;
  private pendingRestart: { index: number; resolve: () => void; reject: (error: DirectError) => void } | undefined;
  private restartChain: Promise<void> = Promise.resolve();
  private restartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: ReceiverSessionOptions) {
    // Drop reads only the page's messages, which never carry ICE servers.
    this.link = new Link(options.exchange, "drop", []);
    this.createPeer = options.createPeer ?? browserPeer;
    this.connectMs = options.connectMs ?? CONNECT_GIVE_UP_MS;
    this.giveUpMs = options.giveUpMs ?? RECONNECT_GIVE_UP_MS;
    this.restartAfterMs = options.restartAfterMs ?? 8000;
    this.gatherMs = options.gatherMs;
  }

  /** Sends the invitation (message 0) as soon as both people have confirmed the check words. */
  async invitation(invite: Omit<Invite, "event">): Promise<void> {
    this.invite = { event: "invite", ...invite };
    try {
      await this.link.send(this.invite);
    } catch (error) {
      throw this.end(error);
    }
  }

  /** Reads the page's manifest, checked against `max`. */
  async readManifest(): Promise<Manifest> {
    const invite = this.invite;
    if (!invite) throw new DirectError("protocol", "No invitation has been sent.");
    try {
      const { message } = await this.link.read({ max: invite.max });
      if (message.event === "stop") throw new DirectError(failureForPeerStop(message.reason));
      if (message.event !== "manifest") throw new DirectError("protocol", "Expected a manifest.");
      this.manifest = message;
      return message;
    } catch (error) {
      throw this.end(error);
    }
  }

  /** Declines the file (message 1). No address was exposed and nothing was allocated. */
  async decline(): Promise<void> {
    try {
      await this.link.send({ event: "decline" });
    } finally {
      this.link.end();
    }
  }

  /**
   * Accepts the file: makes the offer, reads the answer and key, then receives
   * the envelope into the sink. Resolves after KEPT. A dropped connection is
   * answered with an ICE restart over the exchange, up to five times.
   */
  async accept(hooks: ReceiveHooks): Promise<void> {
    const { invite, manifest } = this;
    if (!invite || !manifest) throw new DirectError("protocol", "There is no manifest to accept.");
    const run = new AbortController();
    this.run = run;
    let sink: DirectSink | undefined;
    try {
      const total = envelopeBytes(manifest.name, manifest.type, manifest.size);
      let peer: PeerLike;
      try {
        peer = this.createPeer({ iceServers: hooks.iceServers, hide: hooks.hide, ...(this.gatherMs === undefined ? {} : { gatherMs: this.gatherMs }) });
      } catch (error) {
        throw error instanceof NoRelayError ? new DirectError("no-relay") : error;
      }
      this.peer = peer;
      const watch = watchConnection(peer, {
        connectMs: this.connectMs,
        reconnectMs: this.giveUpMs,
        onReconnecting: hooks.onReconnecting,
        onGiveUp: (error) => this.giveUp(error),
        onState: (state) => this.scheduleRestart(state),
      });
      this.watch = watch;
      const offerSdp = await peer.offer();
      await this.link.send({ event: "accept", sdp: offerSdp });
      hooks.onConnecting?.();
      const { message } = await this.link.read();
      if (message.event === "stop") throw new DirectError(failureForPeerStop(message.reason));
      if (message.event !== "answer") throw new DirectError("protocol", "Expected an answer.");
      await peer.applyAnswer(message.sdp);
      sink = await hooks.createSink({ manifest: { name: manifest.name, size: manifest.size, type: manifest.type }, key: message.key, envelopeBytes: total });
      void this.readAnswers(peer);

      const channel = await Promise.race([peer.channel, watch.failed]);
      this.channel = channel;
      hooks.onConnected?.();
      await Promise.race([
        receiveEnvelope({
          channel,
          envelopeBytes: total,
          plaintextBytes: manifest.size,
          sink,
          signal: run.signal,
          ...(hooks.onProgress ? { onProgress: hooks.onProgress } : {}),
        }),
        watch.failed,
      ]);
      this.finished = true;
    } catch (error) {
      await sink?.abort().catch(() => undefined);
      throw this.end(this.failure ?? error);
    } finally {
      this.watch?.stop();
      clearTimeout(this.restartTimer);
      await drained(this.channel, FLUSH_MS * 4);
      this.close();
    }
  }

  /** Restarts ICE now, as Drop does on a failure or a network change. Resolves when the restart answer has been applied. */
  restartIce(): Promise<void> {
    const turn = this.restartChain.then(() => this.restartOnce());
    this.restartChain = turn.catch(() => undefined);
    return turn;
  }

  /** How many ICE restarts have been started. */
  get restarts(): number {
    return this.restartsUsed;
  }

  /** Ends the session now. See `SenderSession.stop`. */
  stop(reason: Exclude<StopReason, "unsupported"> = "cancelled", options: { immediate?: boolean } = {}): void {
    if (this.finished) return;
    this.failure ??= new DirectError(reason === "cancelled" ? "cancelled" : "protocol");
    this.run?.abort();
    const told = this.link.stop(reason).catch(() => undefined);
    if (options.immediate) this.close();
    else void Promise.race([told, drained(this.channel, FLUSH_MS)]).finally(() => this.close());
  }

  close(): void {
    this.peer?.close();
    this.link.end();
  }

  private giveUp(error: DirectError): DirectError {
    this.failure ??= error;
    this.close();
    return this.failure;
  }

  private end(error: unknown): DirectError {
    const failure = error instanceof DirectError ? error : failureForTransfer(error);
    if (failure.kind === "cancelled") void this.link.stop("cancelled").catch(() => undefined);
    else if (failure.kind === "protocol" || failure.kind === "verification" || failure.kind === "storage") void this.link.stop("failed").catch(() => undefined);
    return failure;
  }

  /** Restarts ICE at once when the connection has failed, or when it has stayed `disconnected` too long. */
  private scheduleRestart(state: PeerState): void {
    if (state === "connected" || state === "closed") {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
      return;
    }
    if (state !== "failed" && state !== "disconnected") return;
    if (this.restartTimer !== undefined && state !== "failed") return;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.restartsUsed < LIMITS.restarts) this.restartIce().catch(() => undefined);
    }, state === "failed" ? 0 : this.restartAfterMs);
  }

  private async restartOnce(): Promise<void> {
    const peer = this.peer;
    if (!peer || this.finished || !this.link.isOpen || peer.state === "closed") throw new DirectError("expired", "The exchange has ended.");
    if (this.restartsUsed >= LIMITS.restarts) throw new DirectError("lost", "No ICE restarts are left.");
    this.restartsUsed += 1;
    const sdp = await peer.offer(true);
    const waiting = new Promise<void>((resolve, reject) => {
      // The page answers at the index Drop's restart takes.
      this.pendingRestart = { index: this.link.sent, resolve, reject };
    });
    waiting.catch(() => undefined);
    await this.link.send({ event: "restart", sdp });
    await waiting;
  }

  /** Reads the page's messages after its answer: restart answers, or a stop. */
  private async readAnswers(peer: PeerLike): Promise<void> {
    for (;;) {
      let incoming;
      try {
        incoming = await this.link.read();
      } catch (error) {
        const failure = exchangeFailure(error);
        this.pendingRestart?.reject(failure);
        this.pendingRestart = undefined;
        if (failure.kind === "protocol" || failure.kind === "unsupported") this.fail(failure);
        return;
      }
      const { message, index } = incoming;
      const pending = this.pendingRestart;
      if (message.event === "stop") {
        this.fail(new DirectError(failureForPeerStop(message.reason)));
        return;
      }
      if (message.event !== "restart-answer" || !pending || pending.index !== index) {
        await this.link.stop("failed").catch(() => undefined);
        this.fail(new DirectError("protocol", "A restart answer nobody asked for."));
        return;
      }
      this.pendingRestart = undefined;
      try {
        await peer.applyAnswer(message.sdp);
        pending.resolve();
      } catch (error) {
        pending.reject(new DirectError("protocol", error instanceof Error ? error.message : "The restart answer was refused."));
      }
    }
  }

  private fail(error: DirectError): void {
    this.failure ??= error;
    this.pendingRestart?.reject(this.failure);
    this.pendingRestart = undefined;
    this.watch?.giveUp();
    this.run?.abort();
    this.peer?.close();
  }
}
