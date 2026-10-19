import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createEnvelopeEncoder, newInputKey, type EnvelopeEncoder } from "../src/core/crypto.js";
import { LIMITS } from "../src/direct/config.js";
import { decodeFrame, encodeAck, encodeData, encodeEnd, encodeKept, encodeStop, type Frame } from "../src/direct/frames.js";
import { createMemorySink } from "../src/direct/sink.js";
import {
  SinkStorageError,
  TransferError,
  receiveEnvelope,
  sendEnvelope,
  type DirectSink,
  type TransferFailure,
} from "../src/direct/transfer.js";
import { channelPair, FakeChannel, settle } from "./helpers/direct-fakes.js";

const sample = (length: number, seed = 1): Uint8Array<ArrayBuffer> =>
  Uint8Array.from({ length }, (_, index) => (index * 31 + seed * 17 + (index >> 8)) & 0xff);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const MiB = 1_048_576;

async function prepare(size: number, options: { name?: string; type?: string; seed?: number } = {}) {
  const name = options.name ?? "photo.jpg";
  const type = options.type ?? "image/jpeg";
  const bytes = sample(size, options.seed);
  const file = new File([bytes], name, { type });
  const key = newInputKey();
  const encoder = await createEnvelopeEncoder(file, { name, type }, { key });
  const manifest = { name, size, type };
  return { bytes, file, key, encoder, manifest, total: encoder.envelopeBytes };
}

function framesOf(channel: FakeChannel, from: "sender" | "receiver"): Frame[] {
  return channel.sent.map((bytes) => decodeFrame(from === "sender" ? "sender" : "receiver", bytes));
}

async function rejection(promise: Promise<unknown>): Promise<TransferError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TransferError);
    return error as TransferError;
  }
  throw new Error("Expected a rejection.");
}

describe("a whole transfer", () => {
  it.each([
    ["one record", 700],
    ["several records", 2 * MiB + 4321],
  ])("moves %s, checks it before KEPT and acknowledges what the sink has written", async (_label, size) => {
    const { bytes, key, encoder, manifest, total } = await prepare(size);
    const [senderChannel, receiverChannel] = channelPair();
    const sink = createMemorySink({ key, manifest, envelopeBytes: total });
    const progress: number[] = [];
    const written: number[] = [];
    const receive = receiveEnvelope({ channel: receiverChannel, envelopeBytes: total, plaintextBytes: size, sink, onProgress: (done) => written.push(done) });
    await sendEnvelope({ channel: senderChannel, encoder, onProgress: (done, of) => { expect(of).toBe(total); progress.push(done); } });
    await receive;

    expect(sink.file).toBeDefined();
    expect(sink.file!.name).toBe("photo.jpg");
    expect(Buffer.from(await sink.file!.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);

    // Progress from the sender is acknowledged bytes only: it starts at 0, rises strictly, and ends at the envelope length.
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(total);
    for (let index = 1; index < progress.length; index += 1) expect(progress[index]).toBeGreaterThan(progress[index - 1]!);
    expect(written.at(-1)).toBe(total);

    const sent = framesOf(senderChannel, "sender");
    expect(sent.at(-1)).toMatchObject({ type: "end", size });
    expect(Buffer.from((sent.at(-1) as Extract<Frame, { type: "end" }>).sha256).toString("hex")).toBe(sha256(bytes));
    const acks = framesOf(receiverChannel, "receiver").filter((frame) => frame.type === "ack") as Extract<Frame, { type: "ack" }>[];
    expect(acks.at(-1)!.next).toBe(total);
    for (let index = 1; index < acks.length; index += 1) expect(acks[index]!.next).toBeGreaterThan(acks[index - 1]!.next);
    // KEPT is the receiver's last word, after every ACK.
    expect(framesOf(receiverChannel, "receiver").at(-1)).toEqual({ type: "kept" });
  }, 30_000);

  it("sends contiguous DATA from offset 0 that adds up to the envelope exactly", async () => {
    const { encoder, key, manifest, total } = await prepare(3 * MiB + 17);
    const [senderChannel, receiverChannel] = channelPair();
    const receive = receiveEnvelope({ channel: receiverChannel, envelopeBytes: total, plaintextBytes: manifest.size, sink: createMemorySink({ key, manifest, envelopeBytes: total }) });
    await sendEnvelope({ channel: senderChannel, encoder });
    await receive;
    let offset = 0;
    for (const frame of framesOf(senderChannel, "sender")) {
      if (frame.type !== "data") continue;
      expect(frame.offset).toBe(offset);
      offset += frame.bytes.length;
    }
    expect(offset).toBe(total);
  }, 30_000);

  it.each([
    [20_000, 20_000],
    [262_144, 65_536],
    [Number.POSITIVE_INFINITY, 65_536],
  ])("keeps every frame within min(max message size %d, 65,536)", async (maxMessageSize, expected) => {
    const { encoder, key, manifest, total } = await prepare(300_000);
    const [senderChannel, receiverChannel] = channelPair({ maxMessageSize });
    const receive = receiveEnvelope({ channel: receiverChannel, envelopeBytes: total, plaintextBytes: manifest.size, sink: createMemorySink({ key, manifest, envelopeBytes: total }) });
    await sendEnvelope({ channel: senderChannel, encoder });
    await receive;
    const longest = Math.max(...senderChannel.sent.map((frame) => frame.length));
    expect(longest).toBe(expected);
  }, 30_000);

  it("stops with STOP 2 when the connection's messages are under 16,384 bytes", async () => {
    const { encoder } = await prepare(1000);
    const [senderChannel, receiverChannel] = channelPair({ maxMessageSize: 16_383 });
    const error = await rejection(sendEnvelope({ channel: senderChannel, encoder }));
    expect(error.kind).toBe("frame-size");
    await settle();
    expect(senderChannel.sent.map((frame) => Array.from(frame))).toEqual([[5, 2]]);
    expect(receiverChannel.open).toBe(true);
  });

  it("accepts messages of exactly 16,384 bytes", async () => {
    const { encoder, key, manifest, total } = await prepare(50_000);
    const [senderChannel, receiverChannel] = channelPair({ maxMessageSize: 16_384 });
    const receive = receiveEnvelope({ channel: receiverChannel, envelopeBytes: total, plaintextBytes: manifest.size, sink: createMemorySink({ key, manifest, envelopeBytes: total }) });
    await sendEnvelope({ channel: senderChannel, encoder });
    await receive;
    expect(Math.max(...senderChannel.sent.map((frame) => frame.length))).toBe(16_384);
  }, 30_000);
});

describe("back-pressure", () => {
  it("pauses past 1 MiB buffered, resumes only when the buffer drains to the low-water mark, and holds a few records", async () => {
    const { encoder, key, manifest, total } = await prepare(6 * MiB);
    const [senderChannel, receiverChannel] = channelPair();
    // Frames wait on the wire until flushed, so the send buffer fills.
    senderChannel.auto = false;
    const sink = createMemorySink({ key, manifest, envelopeBytes: total });
    const receive = receiveEnvelope({ channel: receiverChannel, envelopeBytes: total, plaintextBytes: manifest.size, sink });
    const sending = sendEnvelope({ channel: senderChannel, encoder });
    await settle(50);
    expect(senderChannel.bufferedAmountLowThreshold).toBe(LIMITS.lowWaterBytes);
    expect(senderChannel.bufferedAmount).toBeGreaterThan(LIMITS.highWaterBytes);
    expect(senderChannel.bufferedAmount).toBeLessThanOrEqual(LIMITS.highWaterBytes + LIMITS.frameBytes);
    const paused = senderChannel.sent.length;
    await settle(50);
    expect(senderChannel.sent.length).toBe(paused);

    // Draining part of the way is not enough: it waits for the low-water mark.
    senderChannel.flush(Math.ceil(paused / 2));
    await settle(30);
    expect(senderChannel.bufferedAmount).toBeGreaterThan(LIMITS.lowWaterBytes);
    expect(senderChannel.sent.length).toBe(paused);

    senderChannel.flush();
    await settle(50);
    expect(senderChannel.sent.length).toBeGreaterThan(paused);

    let finished = false;
    const both = Promise.all([sending, receive]).then(() => { finished = true; });
    for (let round = 0; round < 3000 && !finished; round += 1) {
      senderChannel.flush();
      await settle(1);
    }
    await both;
    expect(senderChannel.peakBuffered).toBeLessThanOrEqual(LIMITS.highWaterBytes + LIMITS.frameBytes);
    expect(sink.file?.size).toBe(manifest.size);
  }, 60_000);

  it("never has more than 8 MiB in flight beyond the last ACK", async () => {
    const { encoder } = await prepare(12 * MiB);
    const [senderChannel, receiverChannel] = channelPair();
    const sending = sendEnvelope({ channel: senderChannel, encoder }).catch((error: unknown) => error);
    await settle(400);
    const dataBytes = (): number => framesOf(senderChannel, "sender").reduce((sum, frame) => sum + (frame.type === "data" ? frame.bytes.length : 0), 0);
    const stalledAt = dataBytes();
    // Nothing was acknowledged, so it stops at 8 MiB (to within one frame).
    expect(stalledAt).toBe(LIMITS.unacknowledgedBytes);
    await settle(100);
    expect(dataBytes()).toBe(stalledAt);

    // An ACK of 4 MiB lets it send 4 MiB more, and no further.
    receiverChannel.send(encodeAck(4 * MiB));
    await settle(400);
    expect(dataBytes()).toBe(4 * MiB + LIMITS.unacknowledgedBytes);
    senderChannel.close();
    expect((await sending as TransferError).kind).toBe("closed");
  }, 30_000);

  it("carries on after the path goes quiet and comes back, without a gap or a repeat", async () => {
    const { encoder, key, manifest, total } = await prepare(3 * MiB);
    const [senderChannel, receiverChannel] = channelPair();
    const sink = createMemorySink({ key, manifest, envelopeBytes: total });
    const receive = receiveEnvelope({ channel: receiverChannel, envelopeBytes: total, plaintextBytes: manifest.size, sink });
    const sending = sendEnvelope({ channel: senderChannel, encoder });
    await settle(15);
    // The path goes quiet both ways, as during an ICE restart: SCTP holds the frames and sends them again later.
    senderChannel.stalled = true;
    receiverChannel.stalled = true;
    await settle(60);
    senderChannel.stalled = false;
    receiverChannel.stalled = false;
    senderChannel.flush();
    receiverChannel.flush();
    await Promise.all([sending, receive]);
    expect(sink.file?.size).toBe(manifest.size);
    let offset = 0;
    for (const frame of framesOf(senderChannel, "sender")) if (frame.type === "data") { expect(frame.offset).toBe(offset); offset += frame.bytes.length; }
    expect(offset).toBe(total);
    const acks = framesOf(receiverChannel, "receiver").filter((frame) => frame.type === "ack") as Extract<Frame, { type: "ack" }>[];
    for (let index = 1; index < acks.length; index += 1) expect(acks[index]!.next).toBeGreaterThan(acks[index - 1]!.next);
  }, 30_000);
});

describe("the sender refuses what the protocol forbids", () => {
  async function started() {
    // Larger than the 8 MiB window, so the sender is still mid-transfer, waiting for ACKs, when the frame arrives.
    const prepared = await prepare(12 * MiB);
    const [senderChannel, receiverChannel] = channelPair();
    const sending = sendEnvelope({ channel: senderChannel, encoder: prepared.encoder });
    sending.catch(() => undefined);
    await settle(30);
    return { ...prepared, senderChannel, receiverChannel, sending };
  }
  const stopCodes = (channel: FakeChannel): number[] => channel.sent.filter((frame) => frame[0] === 5).map((frame) => frame[1]!);

  it.each<[string, (sent: number) => Uint8Array, TransferFailure]>([
    ["an ACK of zero", () => encodeAck(0), "protocol"],
    ["an ACK past what was sent", (sent) => encodeAck(sent + 1), "protocol"],
    ["KEPT before END", () => encodeKept(), "protocol"],
    ["an empty message", () => new Uint8Array(0), "protocol"],
    ["DATA from the receiver", () => encodeData(0, new Uint8Array(1)), "protocol"],
    ["an unknown type", () => Uint8Array.of(9, 0), "protocol"],
    ["the reserved resume type", () => Uint8Array.of(6, 0, 0, 0, 0, 0, 0, 0, 0), "protocol"],
    ["STOP 1", () => encodeStop(1), "peer-cancelled"],
    ["STOP 2", () => encodeStop(2), "peer-failed"],
    ["STOP 3", () => encodeStop(3), "peer-storage"],
  ])("fails on %s", async (_label, frame, kind) => {
    const { senderChannel, sending } = await started();
    const sent = senderChannel.sent.reduce((sum, bytes) => sum + (bytes[0] === 1 ? bytes.length - 9 : 0), 0);
    senderChannel.inject(frame(sent));
    expect((await rejection(sending)).kind).toBe(kind);
    // Our own failures send STOP 2; a STOP from them is not answered.
    expect(stopCodes(senderChannel)).toEqual(kind === "protocol" ? [2] : []);
  }, 30_000);

  it("fails with 'closed' if the channel closes before KEPT, and says nothing after KEPT", async () => {
    const { senderChannel, sending } = await started();
    senderChannel.close();
    expect((await rejection(sending)).kind).toBe("closed");
  }, 30_000);

  it("fails with 'closed' on a channel that was never open", async () => {
    const { encoder } = await prepare(100);
    const [senderChannel] = channelPair();
    senderChannel.open = false;
    expect((await rejection(sendEnvelope({ channel: senderChannel, encoder }))).kind).toBe("closed");
  });

  it("sends STOP 1 and rejects with 'cancelled' when told to stop", async () => {
    const prepared = await prepare(4 * MiB);
    const [senderChannel] = channelPair();
    const controller = new AbortController();
    const sending = sendEnvelope({ channel: senderChannel, encoder: prepared.encoder, signal: controller.signal });
    sending.catch(() => undefined);
    await settle(20);
    controller.abort();
    expect((await rejection(sending)).kind).toBe("cancelled");
    expect(stopCodes(senderChannel)).toEqual([1]);
    expect((await rejection(sendEnvelope({ channel: senderChannel, encoder: (await prepare(10)).encoder, signal: controller.signal }))).kind).toBe("cancelled");
  }, 30_000);

  it("reports a file it cannot read as 'source' and tells the receiver STOP 2", async () => {
    const bytes = sample(3 * MiB);
    const shrinking = { size: bytes.length, slice: (start: number, end: number) => ({ arrayBuffer: async () => (start >= MiB ? bytes.slice(start, start + 5).buffer : bytes.slice(start, end).buffer) }) } as unknown as Blob;
    const encoder = await createEnvelopeEncoder(shrinking, { name: "a.bin", type: "" });
    const [senderChannel] = channelPair();
    const error = await rejection(sendEnvelope({ channel: senderChannel, encoder }));
    expect(error.kind).toBe("source");
    expect(stopCodes(senderChannel)).toEqual([2]);
  }, 30_000);

  it("lets the person's own END and then waits for KEPT before resolving", async () => {
    const { encoder, key, manifest, total } = await prepare(1000);
    const [senderChannel, receiverChannel] = channelPair();
    let resolved = false;
    const sending = sendEnvelope({ channel: senderChannel, encoder }).then(() => { resolved = true; });
    await settle(30);
    expect(framesOf(senderChannel, "sender").at(-1)?.type).toBe("end");
    expect(resolved).toBe(false);
    receiverChannel.send(encodeAck(total));
    await settle(30);
    expect(resolved).toBe(false);
    receiverChannel.send(encodeKept());
    await sending;
    expect(resolved).toBe(true);
    void key; void manifest;
  });
});

describe("the receiver refuses what the protocol forbids", () => {
  function fakeSink(): DirectSink & { writes: number; ended: number; aborted: number } {
    return {
      writes: 0,
      ended: 0,
      aborted: 0,
      async write() { this.writes += 1; },
      async end() { this.ended += 1; },
      async abort() { this.aborted += 1; },
    };
  }
  const TOTAL = 100_000;
  const stopCodes = (channel: FakeChannel): number[] => channel.sent.filter((frame) => frame[0] === 5).map((frame) => frame[1]!);
  const END = encodeEnd(new Uint8Array(32), 90_000);

  function receiving(sink: DirectSink = fakeSink(), overrides: { envelopeBytes?: number } = {}) {
    const [receiverChannel, senderChannel] = channelPair();
    const done = receiveEnvelope({ channel: receiverChannel, envelopeBytes: overrides.envelopeBytes ?? TOTAL, plaintextBytes: 90_000, sink });
    done.catch(() => undefined);
    return { receiverChannel, senderChannel, done, sink };
  }

  it.each<[string, Uint8Array[], TransferFailure]>([
    ["a gap", [encodeData(0, new Uint8Array(100)), encodeData(101, new Uint8Array(100))], "protocol"],
    ["an overlap", [encodeData(0, new Uint8Array(100)), encodeData(50, new Uint8Array(100))], "protocol"],
    ["DATA that does not start at 0", [encodeData(1, new Uint8Array(100))], "protocol"],
    ["a byte past the end", [encodeData(0, new Uint8Array(TOTAL + 1).subarray(0, 65_000)), encodeData(65_000, new Uint8Array(35_001))], "protocol"],
    ["END before every byte", [encodeData(0, new Uint8Array(100)), END], "protocol"],
    ["an ACK from the sender", [encodeAck(1)], "protocol"],
    ["KEPT from the sender", [encodeKept()], "protocol"],
    ["an empty message", [new Uint8Array(0)], "protocol"],
    ["an unknown type", [Uint8Array.of(0)], "protocol"],
    ["the reserved resume type", [Uint8Array.of(6, 0, 0, 0, 0, 0, 0, 0, 0)], "protocol"],
    ["STOP 1", [encodeStop(1)], "peer-cancelled"],
    ["STOP 2", [encodeStop(2)], "peer-failed"],
    ["STOP 3", [encodeStop(3)], "peer-storage"],
  ])("fails on %s, aborts the sink and answers with STOP 2 only for a protocol failure", async (_label, frames, kind) => {
    const { receiverChannel, done, sink } = receiving();
    for (const frame of frames) receiverChannel.inject(frame);
    expect((await rejection(done)).kind).toBe(kind);
    expect((sink as ReturnType<typeof fakeSink>).aborted).toBe(1);
    expect(stopCodes(receiverChannel)).toEqual(kind === "protocol" ? [2] : []);
    expect((sink as ReturnType<typeof fakeSink>).ended).toBe(0);
  });

  it("refuses DATA after END and a second END", async () => {
    const sink = fakeSink();
    const [receiverChannel, senderChannel] = channelPair();
    const done = receiveEnvelope({ channel: receiverChannel, envelopeBytes: 1000, plaintextBytes: 900, sink });
    done.catch(() => undefined);
    receiverChannel.inject(encodeData(0, new Uint8Array(1000)));
    receiverChannel.inject(encodeEnd(new Uint8Array(32), 900));
    receiverChannel.inject(encodeEnd(new Uint8Array(32), 900));
    expect((await rejection(done)).kind).toBe("protocol");
    void senderChannel;
  });

  it("refuses an END that names a different size from the manifest", async () => {
    const sink = fakeSink();
    const [receiverChannel] = channelPair();
    const done = receiveEnvelope({ channel: receiverChannel, envelopeBytes: 1000, plaintextBytes: 900, sink });
    done.catch(() => undefined);
    receiverChannel.inject(encodeData(0, new Uint8Array(1000)));
    receiverChannel.inject(encodeEnd(new Uint8Array(32), 901));
    expect((await rejection(done)).kind).toBe("verification");
    expect(sink.ended).toBe(0);
    expect(stopCodes(receiverChannel)).toEqual([2]);
  });

  it("sends KEPT only after the sink has verified, and STOP 2 with the sink aborted if it refuses", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sink = { ...fakeSink(), end: vi.fn(async (_end: { sha256: Uint8Array; size: number }) => { await gate; }) };
    const [receiverChannel] = channelPair();
    const done = receiveEnvelope({ channel: receiverChannel, envelopeBytes: 1000, plaintextBytes: 900, sink });
    receiverChannel.inject(encodeData(0, new Uint8Array(1000)));
    receiverChannel.inject(encodeEnd(new Uint8Array(32).fill(3), 900));
    await settle(20);
    expect(sink.end).toHaveBeenCalledTimes(1);
    expect(sink.end.mock.calls[0]![0]).toMatchObject({ size: 900 });
    expect(receiverChannel.sent.some((frame) => frame[0] === 4)).toBe(false);
    release();
    await done;
    expect(receiverChannel.sent.at(-1)).toEqual(Uint8Array.of(4));

    const refusing = { ...fakeSink(), end: vi.fn(async (_end: { sha256: Uint8Array; size: number }) => { throw new Error("hash differs"); }) };
    const [second] = channelPair();
    const refused = receiveEnvelope({ channel: second, envelopeBytes: 1000, plaintextBytes: 900, sink: refusing });
    refused.catch(() => undefined);
    second.inject(encodeData(0, new Uint8Array(1000)));
    second.inject(encodeEnd(new Uint8Array(32), 900));
    expect((await rejection(refused)).kind).toBe("verification");
    expect(refusing.aborted).toBe(1);
    expect(second.sent.map((frame) => Array.from(frame))).toEqual([[2, 0, 0, 0, 0, 0, 0, 3, 232], [5, 2]]);
  });

  it("answers a sink that has no room with STOP 3", async () => {
    const sink = { ...fakeSink(), write: vi.fn(async () => { throw new SinkStorageError(); }) };
    const [receiverChannel] = channelPair();
    const done = receiveEnvelope({ channel: receiverChannel, envelopeBytes: 1000, plaintextBytes: 900, sink });
    done.catch(() => undefined);
    receiverChannel.inject(encodeData(0, new Uint8Array(100)));
    expect((await rejection(done)).kind).toBe("storage");
    expect(stopCodes(receiverChannel)).toEqual([3]);
    expect(sink.aborted).toBe(1);
  });

  it("acknowledges only what the sink has written, at least every MiB and at the end", async () => {
    const releases: (() => void)[] = [];
    const sink: DirectSink = {
      write: () => new Promise<void>((resolve) => { releases.push(resolve); }),
      end: async () => undefined,
      abort: async () => undefined,
    };
    const total = 2 * MiB + 10;
    const [receiverChannel] = channelPair();
    const done = receiveEnvelope({ channel: receiverChannel, envelopeBytes: total, plaintextBytes: 5, sink });
    done.catch(() => undefined);
    let offset = 0;
    while (offset < total) {
      const take = Math.min(65_527, total - offset);
      receiverChannel.inject(encodeData(offset, new Uint8Array(take)));
      offset += take;
    }
    await settle(10);
    // Nothing has been written, so nothing is acknowledged.
    expect(receiverChannel.sent.filter((frame) => frame[0] === 2)).toHaveLength(0);
    // Writes complete one at a time, in order.
    let acknowledged = 0;
    for (let index = 0; index < 100 && acknowledged < total; index += 1) {
      releases.shift()?.();
      await settle(0);
      const acks = framesOf(receiverChannel, "receiver").filter((frame) => frame.type === "ack") as Extract<Frame, { type: "ack" }>[];
      const last = acks.at(-1)?.next ?? 0;
      expect(last).toBeGreaterThanOrEqual(acknowledged);
      acknowledged = last;
    }
    await settle(10);
    const acks = (framesOf(receiverChannel, "receiver").filter((frame) => frame.type === "ack") as Extract<Frame, { type: "ack" }>[]).map((frame) => frame.next);
    expect(acks.at(-1)).toBe(total);
    expect(acks.length).toBeGreaterThanOrEqual(2);
    for (let index = 0; index < acks.length; index += 1) {
      const previous = index === 0 ? 0 : acks[index - 1]!;
      expect(acks[index]! - previous).toBeGreaterThanOrEqual(Math.min(MiB, total - previous - 0));
    }
  });

  it("fails a sender that gets more than 8 MiB ahead of the last ACK", async () => {
    const sink: DirectSink = { write: () => new Promise<void>(() => undefined), end: async () => undefined, abort: async () => undefined };
    const [receiverChannel] = channelPair();
    const total = 10 * MiB;
    const done = receiveEnvelope({ channel: receiverChannel, envelopeBytes: total, plaintextBytes: 5, sink });
    done.catch(() => undefined);
    let offset = 0;
    while (offset < total && receiverChannel.open) {
      const take = 65_527;
      receiverChannel.inject(encodeData(offset, new Uint8Array(take)));
      offset += take;
      if (offset > LIMITS.unacknowledgedBytes + 2 * take) break;
    }
    // The sink never finishes a write, so the abort waits on it: the failure is the thing under test.
    await settle(10);
    expect(stopCodes(receiverChannel)).toEqual([2]);
  });

  it("deletes what it held when the channel closes, and when told to stop", async () => {
    const closed = receiving();
    closed.receiverChannel.inject(encodeData(0, new Uint8Array(100)));
    closed.receiverChannel.close();
    expect((await rejection(closed.done)).kind).toBe("closed");
    expect((closed.sink as ReturnType<typeof fakeSink>).aborted).toBe(1);

    const controller = new AbortController();
    const sink = fakeSink();
    const [receiverChannel] = channelPair();
    const done = receiveEnvelope({ channel: receiverChannel, envelopeBytes: TOTAL, plaintextBytes: 90_000, sink, signal: controller.signal });
    controller.abort();
    expect((await rejection(done)).kind).toBe("cancelled");
    expect(sink.aborted).toBe(1);
    expect(stopCodes(receiverChannel)).toEqual([1]);
  });

  it("does not abort a sink whose file was kept", async () => {
    const sink = fakeSink();
    const [receiverChannel] = channelPair();
    const done = receiveEnvelope({ channel: receiverChannel, envelopeBytes: 1000, plaintextBytes: 900, sink });
    receiverChannel.inject(encodeData(0, new Uint8Array(1000)));
    receiverChannel.inject(encodeEnd(new Uint8Array(32), 900));
    await done;
    receiverChannel.close();
    await settle();
    expect(sink.aborted).toBe(0);
  });
});

describe("a sink that opens the envelope with the page's own reader", () => {
  it("refuses the wrong key, a different manifest and a lying END, and offers no file for any of them", async () => {
    const { encoder, key, manifest, total, bytes } = await prepare(70_000);
    const records: Uint8Array[] = [encoder.header];
    for (let record = await encoder.next(); record; record = await encoder.next()) records.push(record);
    const digest = encoder.digest();
    const feed = async (sink: ReturnType<typeof createMemorySink>): Promise<void> => {
      for (const part of records) await sink.write(part);
    };
    const wrongKey = createMemorySink({ key: newInputKey(), manifest, envelopeBytes: total });
    await feed(wrongKey);
    await expect(wrongKey.end({ sha256: digest, size: manifest.size })).rejects.toThrow();
    expect(wrongKey.file).toBeUndefined();

    const otherName = createMemorySink({ key, manifest: { ...manifest, name: "other.jpg" }, envelopeBytes: total });
    await feed(otherName);
    await expect(otherName.end({ sha256: digest, size: manifest.size })).rejects.toThrow(/manifest/u);
    expect(otherName.file).toBeUndefined();

    const lying = createMemorySink({ key, manifest, envelopeBytes: total });
    await feed(lying);
    await expect(lying.end({ sha256: new Uint8Array(32), size: manifest.size })).rejects.toThrow(/SHA-256/u);
    expect(lying.file).toBeUndefined();

    const wrongSize = createMemorySink({ key, manifest, envelopeBytes: total });
    await feed(wrongSize);
    await expect(wrongSize.end({ sha256: digest, size: manifest.size + 1 })).rejects.toThrow(/size/u);

    const flipped = createMemorySink({ key, manifest, envelopeBytes: total });
    const damaged = records.map((part) => part.slice());
    damaged.at(-1)![10] = damaged.at(-1)![10]! ^ 1;
    for (const part of damaged) await flipped.write(part);
    await expect(flipped.end({ sha256: digest, size: manifest.size })).rejects.toThrow();
    expect(flipped.file).toBeUndefined();

    const good = createMemorySink({ key, manifest, envelopeBytes: total });
    await feed(good);
    expect(good.file).toBeUndefined();
    await good.end({ sha256: digest, size: manifest.size });
    expect(Buffer.from(await good.file!.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    await good.abort();
    expect(good.file).toBeUndefined();
  }, 30_000);

  it("refuses an envelope that is short or long", async () => {
    const { key, manifest, total } = await prepare(100);
    const sink = createMemorySink({ key, manifest, envelopeBytes: total });
    await sink.write(new Uint8Array(total));
    await expect(sink.write(new Uint8Array(1))).rejects.toThrow(/More bytes/u);
    const short = createMemorySink({ key, manifest, envelopeBytes: total });
    await short.write(new Uint8Array(total - 1));
    await expect(short.end({ sha256: new Uint8Array(32), size: manifest.size })).rejects.toThrow(/not complete/u);
    await short.abort();
    await expect(short.write(new Uint8Array(1))).rejects.toThrow(/closed/u);
  });
});

describe("an encoder is not needed after the transfer", () => {
  it("leaves disposal to the caller", async () => {
    const { encoder, key, manifest, total } = await prepare(100);
    const [senderChannel, receiverChannel] = channelPair();
    const receive = receiveEnvelope({ channel: receiverChannel, envelopeBytes: total, plaintextBytes: manifest.size, sink: createMemorySink({ key, manifest, envelopeBytes: total }) });
    await sendEnvelope({ channel: senderChannel, encoder });
    await receive;
    const spy = vi.spyOn(encoder as EnvelopeEncoder, "dispose");
    expect(spy).not.toHaveBeenCalled();
    encoder.dispose();
  });
});
