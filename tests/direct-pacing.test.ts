import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvelopeEncoder, newInputKey } from "../src/core/crypto.js";
import { LIMITS } from "../src/direct/config.js";
import { createPathPacing, createRatePacer, stricter, watchPath } from "../src/direct/pacing.js";
import { createMemorySink } from "../src/direct/sink.js";
import { protocolPacing, receiveEnvelope, sendEnvelope, type Pacing, type PacingState } from "../src/direct/transfer.js";
import { channelPair } from "./helpers/direct-fakes.js";

const realSetTimeout = globalThis.setTimeout;
const realDelay = (ms: number): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms));

afterEach(() => vi.useRealTimers());

const FRAME = 65_527;
const state = (overrides: Partial<PacingState> = {}): PacingState => ({ inFlight: 0, buffered: 0, paused: false, sent: 0, wanted: FRAME, ...overrides });

interface Send {
  readonly time: number;
  readonly bytes: number;
}

/**
 * A sender that asks the rule, sends a frame when it is allowed, and otherwise lets the clock run for as long as
 * the rule asks, on a clock the test owns.
 */
function simulate(pacing: Pacing, clock: { t: number }, options: { wanted?: number; until: number; from?: number }): Send[] {
  const wanted = options.wanted ?? FRAME;
  const sends: Send[] = [];
  let sent = 0;
  clock.t = options.from ?? clock.t;
  while (clock.t < options.until) {
    const verdict = pacing(state({ sent, wanted }));
    if (verdict.bytes > 0) {
      const take = Math.min(wanted, verdict.bytes);
      sends.push({ time: clock.t, bytes: take });
      sent += take;
    } else {
      clock.t += verdict.retryMs ?? 1;
    }
  }
  return sends;
}

const total = (sends: readonly Send[]): number => sends.reduce((sum, send) => sum + send.bytes, 0);
/** The most sent inside any window of this many milliseconds. */
function busiestWindow(sends: readonly Send[], windowMs: number): number {
  let most = 0;
  for (const start of sends) {
    most = Math.max(most, total(sends.filter((send) => send.time >= start.time && send.time < start.time + windowMs)));
  }
  return most;
}

describe("stricter", () => {
  const allow = (bytes: number, retryMs?: number): Pacing => () => (retryMs === undefined ? { bytes } : { bytes, retryMs });

  it("allows the fewest bytes any rule allows", () => {
    expect(stricter(allow(100), allow(40), allow(70))(state())).toEqual({ bytes: 40 });
    expect(stricter(allow(100))(state())).toEqual({ bytes: 100 });
  });

  it("when a rule says none, asks again at the soonest time any rule asks for, and ignores the time of a rule that allowed bytes", () => {
    expect(stricter(allow(0, 80), allow(0, 30), allow(0))(state())).toEqual({ bytes: 0, retryMs: 30 });
    expect(stricter(allow(50, 5), allow(0, 80))(state())).toEqual({ bytes: 0, retryMs: 80 });
    expect(stricter(allow(0), allow(10))(state())).toEqual({ bytes: 0 });
  });
});

describe("the relay rate", () => {
  it("allows 400,000 bytes a second on average over a long run, in bursts of at most 65,536", () => {
    const clock = { t: 0 };
    const pacer = createRatePacer({ now: () => clock.t });
    const sends = simulate(pacer.pacing, clock, { until: 120_000 });
    // Never more than the bucket plus what the clock refilled, and not much less: the rate is used.
    expect(total(sends)).toBeLessThanOrEqual(LIMITS.relayBurstBytes + 400_000 * 120);
    expect(total(sends)).toBeGreaterThanOrEqual(400_000 * 120 * 0.98);
    expect(Math.max(...sends.map((send) => send.bytes))).toBeLessThanOrEqual(65_536);
    // No instant carries more than the bucket holds.
    const byInstant = new Map<number, number>();
    for (const send of sends) byInstant.set(send.time, (byInstant.get(send.time) ?? 0) + send.bytes);
    expect(Math.max(...byInstant.values())).toBeLessThanOrEqual(65_536);
    // And any second carries the rate plus one burst at most.
    expect(busiestWindow(sends, 1000)).toBeLessThanOrEqual(400_000 + 65_536);
  });

  it("holds the same rate for smaller frames, and still sends whole frames", () => {
    for (const wanted of [16_375, 1_000, 65_527]) {
      const clock = { t: 0 };
      const sends = simulate(createRatePacer({ now: () => clock.t }).pacing, clock, { wanted, until: 30_000 });
      expect(total(sends)).toBeLessThanOrEqual(LIMITS.relayBurstBytes + 400_000 * 30);
      expect(total(sends)).toBeGreaterThanOrEqual(400_000 * 30 * 0.97);
      expect(sends.every((send) => send.bytes === wanted)).toBe(true);
      expect(busiestWindow(sends, 1000)).toBeLessThanOrEqual(400_000 + 65_536);
    }
  });

  it("asks to be asked again when the bucket will hold the frame, and the frame is then allowed", () => {
    const clock = { t: 1_000 };
    const pacer = createRatePacer({ now: () => clock.t });
    expect(pacer.pacing(state({ sent: 0 })).bytes).toBeGreaterThanOrEqual(FRAME);
    // The frame went out; the bucket holds 9 bytes.
    const wait = pacer.pacing(state({ sent: FRAME }));
    expect(wait.bytes).toBe(0);
    expect(wait.retryMs).toBeGreaterThan(0);
    clock.t += wait.retryMs!;
    expect(pacer.pacing(state({ sent: FRAME })).bytes).toBeGreaterThanOrEqual(FRAME);
  });

  it("charges only what was sent: a frame that is not taken costs nothing", () => {
    const clock = { t: 0 };
    const pacer = createRatePacer({ now: () => clock.t });
    for (let ask = 0; ask < 5; ask += 1) expect(pacer.pacing(state({ sent: 0 })).bytes).toBeGreaterThanOrEqual(FRAME);
  });

  it("takes a custom rate and burst", () => {
    const clock = { t: 0 };
    const sends = simulate(createRatePacer({ bytesPerSecond: 100_000, burstBytes: 20_000, now: () => clock.t }).pacing, clock, { wanted: 10_000, until: 10_000 });
    expect(total(sends)).toBeLessThanOrEqual(20_000 + 100_000 * 10);
    expect(Math.max(...sends.map((send) => send.bytes))).toBe(10_000);
    expect(busiestWindow(sends, 1000)).toBeLessThanOrEqual(120_000);
  });

  it("does not carry debt across a reset", () => {
    const clock = { t: 0 };
    const pacer = createRatePacer({ now: () => clock.t });
    expect(pacer.pacing(state({ sent: 0 })).bytes).toBeGreaterThan(0);
    // A long stretch went by with no pacing (the sender sent 8 MiB), then pacing starts again.
    pacer.reset();
    expect(pacer.pacing(state({ sent: 8 * 1024 * 1024 })).bytes).toBeGreaterThanOrEqual(FRAME);
  });
});

describe("pacing that follows the path", () => {
  it("is paced until the pair is known, and when it is relayed", () => {
    const clock = { t: 0 };
    for (const relayed of [undefined, true] as const) {
      const path = createPathPacing({ now: () => clock.t });
      path.setRelayed(relayed);
      expect(path.relayed).toBe(relayed);
      const sends = simulate(path.pacing, clock, { from: 0, until: 20_000 });
      expect(total(sends)).toBeLessThanOrEqual(LIMITS.relayBurstBytes + 400_000 * 20);
      expect(busiestWindow(sends, 1000)).toBeLessThanOrEqual(400_000 + 65_536);
    }
  });

  it("does not pace a direct pair: only the protocol's window and buffer rules apply", () => {
    const path = createPathPacing({ now: () => 0 });
    path.setRelayed(false);
    expect(path.pacing(state({ sent: 50 * 1024 * 1024 }))).toEqual(protocolPacing(state({ sent: 50 * 1024 * 1024 })));
    expect(path.pacing(state({ inFlight: LIMITS.unacknowledgedBytes })).bytes).toBe(0);
    expect(path.pacing(state({ paused: true })).bytes).toBe(0);
  });

  it("still holds a relayed send to the protocol's window and to a full buffer", () => {
    const path = createPathPacing({ now: () => 0 });
    path.setRelayed(true);
    expect(path.pacing(state({ inFlight: LIMITS.unacknowledgedBytes })).bytes).toBe(0);
    expect(path.pacing(state({ paused: true })).bytes).toBe(0);
    expect(path.pacing(state()).bytes).toBeGreaterThanOrEqual(FRAME);
  });

  it("switches on and off as the pair changes, after a restart, and holds each stretch to its own rule", () => {
    const clock = { t: 0 };
    const path = createPathPacing({ now: () => clock.t });
    let sent = 0;
    const run = (until: number): Send[] => {
      const sends: Send[] = [];
      while (clock.t < until) {
        const verdict = path.pacing(state({ sent }));
        if (verdict.bytes > 0) {
          const take = Math.min(FRAME, verdict.bytes);
          sends.push({ time: clock.t, bytes: take });
          sent += take;
          // The unpaced stretch sends in a hurry; give it something to stop it looping for ever.
          if (path.relayed === false && sends.length > 200) clock.t = until;
        } else {
          clock.t += verdict.retryMs ?? 1;
        }
      }
      return sends;
    };

    path.setRelayed(false);
    const direct = run(1_000);
    expect(direct.length).toBeGreaterThan(100);

    // The restart moved the send onto a relay: from now on it is paced.
    path.setRelayed(true);
    const relayed = run(clock.t + 10_000);
    expect(total(relayed)).toBeLessThanOrEqual(LIMITS.relayBurstBytes + 400_000 * 10);
    expect(total(relayed)).toBeGreaterThanOrEqual(400_000 * 10 * 0.95);
    expect(busiestWindow(relayed, 1000)).toBeLessThanOrEqual(400_000 + 65_536);

    // Another restart, back to a direct pair: unpaced again.
    path.setRelayed(false);
    expect(run(clock.t + 1_000).length).toBeGreaterThan(100);

    // And onto a relay a third time, after a long unpaced stretch that must not be held against it.
    path.setRelayed(true);
    const again = run(clock.t + 10_000);
    expect(total(again)).toBeGreaterThanOrEqual(400_000 * 10 * 0.95);
    expect(again[0]!.bytes).toBeLessThanOrEqual(65_536);
  });
});

describe("a send held to the relay rate", () => {
  // The whole transfer on a clock the test drives, with the real encoder and the real receiver.
  async function transfer(relayed: boolean): Promise<{ elapsedMs: number; frames: Send[]; envelope: number }> {
    const bytes = Uint8Array.from({ length: 1_500_000 }, (_, index) => (index * 31) & 0xff);
    const file = new File([bytes], "held.bin", { type: "application/octet-stream" });
    const key = newInputKey();
    const encoder = await createEnvelopeEncoder(file, { name: file.name, type: file.type }, { key });
    const manifest = { name: file.name, size: file.size, type: file.type };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const [senderChannel, receiverChannel] = channelPair();
    const frames: Send[] = [];
    const original = senderChannel.send.bind(senderChannel);
    senderChannel.send = (frame: Uint8Array): void => {
      if (frame[0] === 1) frames.push({ time: Date.now(), bytes: frame.length - 9 });
      original(frame);
    };
    const path = createPathPacing({ now: () => Date.now() });
    path.setRelayed(relayed);
    const sink = createMemorySink({ key, manifest, envelopeBytes: encoder.envelopeBytes });
    const receiving = receiveEnvelope({ channel: receiverChannel, envelopeBytes: encoder.envelopeBytes, plaintextBytes: file.size, sink });
    const sending = sendEnvelope({ channel: senderChannel, encoder, pacing: path.pacing });
    let done = false;
    const both = Promise.all([sending, receiving]).then(() => { done = true; });
    const started = Date.now();
    for (let turn = 0; turn < 4000 && !done; turn += 1) {
      await vi.advanceTimersByTimeAsync(20);
      // The encoder and the receiver use real crypto, which finishes on the real clock.
      await realDelay(1);
    }
    await both;
    expect(sink.file?.size).toBe(file.size);
    return { elapsedMs: Date.now() - started, frames, envelope: encoder.envelopeBytes };
  }

  it("takes as long as the rate says, never bursts above one frame and never exceeds the rate in any second", async () => {
    const run = await transfer(true);
    const wanted = ((run.envelope - LIMITS.relayBurstBytes) / 400_000) * 1000;
    expect(run.elapsedMs).toBeGreaterThanOrEqual(wanted * 0.97);
    expect(run.elapsedMs).toBeLessThan(wanted + 1_500);
    expect(Math.max(...run.frames.map((frame) => frame.bytes))).toBeLessThanOrEqual(65_536);
    expect(busiestWindow(run.frames, 1000)).toBeLessThanOrEqual(400_000 + 65_536);
  }, 60_000);

  it("takes no time to speak of on a direct pair", async () => {
    const run = await transfer(false);
    expect(run.elapsedMs).toBeLessThan(400);
  }, 60_000);
});

describe("watching the selected pair", () => {
  it("reads the pair, applies the answer, and reads again as the restart settles", async () => {
    vi.useFakeTimers();
    const answers: (boolean | undefined)[] = [false];
    const applied: (boolean | undefined)[] = [];
    const watch = watchPath(async () => answers[0], (relayed) => applied.push(relayed), { settleMs: [1500, 5000] });
    await watch.refresh();
    expect(applied).toEqual([false]);

    // A restart moves the send onto a relay; the pair settles after a moment.
    watch.afterRestart();
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([false, false]);
    answers[0] = true;
    await vi.advanceTimersByTimeAsync(1_499);
    expect(applied).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(2);
    expect(applied).toEqual([false, false, true]);
    await vi.advanceTimersByTimeAsync(3_600);
    expect(applied).toEqual([false, false, true, true]);
    watch.stop();
  });

  it("keeps asking while no pair is selected, up to a limit, then stops", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const applied: (boolean | undefined)[] = [];
    const watch = watchPath(async () => { reads += 1; return reads >= 4 ? true : undefined; }, (relayed) => applied.push(relayed), { retryMs: 100, maxRetries: 10 });
    await watch.refresh();
    expect(applied).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(applied).toEqual([true]);
    expect(reads).toBe(4);

    reads = Number.NEGATIVE_INFINITY;
    const limited = watchPath(async () => { reads += 1; return undefined; }, () => undefined, { retryMs: 100, maxRetries: 3 });
    reads = 0;
    await limited.refresh();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reads).toBe(1 + 3);
    limited.stop();
  });

  it("leaves the last answer standing when a read fails, and a newer refresh replaces the older retries", async () => {
    vi.useFakeTimers();
    const applied: (boolean | undefined)[] = [];
    let mode: "ok" | "throw" | "none" = "ok";
    const watch = watchPath(async () => {
      if (mode === "throw") throw new Error("stats unavailable");
      return mode === "none" ? undefined : true;
    }, (relayed) => applied.push(relayed), { retryMs: 100, maxRetries: 50 });
    await watch.refresh();
    mode = "throw";
    await watch.refresh();
    expect(applied).toEqual([true]);
    mode = "none";
    await watch.refresh();
    mode = "ok";
    await vi.advanceTimersByTimeAsync(150);
    expect(applied).toEqual([true, true]);
    // Retries ended once a pair was found, and a stopped watch reads no more.
    const count = applied.length;
    watch.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(applied).toHaveLength(count);
  });
});
