import { LIMITS } from "./config.js";
import { protocolPacing, type Pacing } from "./transfer.js";

/**
 * Pacing for a relayed send (wildbloom-direct/1, "Data channel and frames").
 *
 * A TURN server enforces a rate on each allocation by dropping what exceeds it,
 * and SCTP recovers from those drops so slowly that an unpaced send through a
 * 1,000,000-byte-a-second limit crawls. When the selected candidate pair has a
 * relay candidate at either end, the sender therefore sends on average at most
 * 400,000 envelope bytes a second, in bursts of at most 65,536. A direct pair is
 * not paced.
 */

/** The stricter of several rules: the fewest bytes any of them allows, and the soonest any of them asks to be asked again. */
export function stricter(...rules: readonly Pacing[]): Pacing {
  return (state) => {
    let bytes = Number.POSITIVE_INFINITY;
    let retryMs: number | undefined;
    for (const rule of rules) {
      const verdict = rule(state);
      bytes = Math.min(bytes, verdict.bytes);
      if (verdict.bytes <= 0 && verdict.retryMs !== undefined) retryMs = retryMs === undefined ? verdict.retryMs : Math.min(retryMs, verdict.retryMs);
    }
    if (bytes > 0) return { bytes };
    return retryMs === undefined ? { bytes: 0 } : { bytes: 0, retryMs };
  };
}

export interface RatePacerOptions {
  readonly bytesPerSecond?: number;
  readonly burstBytes?: number;
  /** Milliseconds, from any steady clock. Tests supply their own. */
  readonly now?: () => number;
}

export interface RatePacer {
  readonly pacing: Pacing;
  /** Forgets what was spent and refills the bucket, as when pacing starts again after a stretch without it. */
  reset(): void;
}

/**
 * A token bucket: it holds up to `burstBytes` and refills at `bytesPerSecond`. A frame is allowed only once
 * the bucket holds all of it, so frames are never cut small, and what is spent is learned from the change in
 * the bytes sent, so the sender needs no way to report it. Over any stretch it allows no more than the bucket
 * plus the rate times the stretch.
 */
export function createRatePacer(options: RatePacerOptions = {}): RatePacer {
  const rate = options.bytesPerSecond ?? LIMITS.relayBytesPerSecond;
  const burst = options.burstBytes ?? LIMITS.relayBurstBytes;
  const now = options.now ?? ((): number => performance.now());
  let tokens = burst;
  let lastSent: number | undefined;
  let lastTime = 0;
  return {
    pacing({ sent, wanted }) {
      const time = now();
      if (lastSent === undefined) {
        tokens = burst;
      } else {
        tokens = Math.min(burst, tokens - (sent - lastSent) + ((time - lastTime) / 1000) * rate);
      }
      lastSent = sent;
      lastTime = time;
      // The most a frame can need is the bucket, so a frame is never starved by being larger than it.
      const need = Math.min(wanted, burst);
      if (tokens >= need) return { bytes: Math.max(1, Math.floor(tokens)) };
      return { bytes: 0, retryMs: Math.max(1, Math.ceil(((need - tokens) / rate) * 1000)) };
    },
    reset(): void {
      lastSent = undefined;
    },
  };
}

/** While the pair is unknown, a sender with nothing to send asks again at least this often. */
const UNKNOWN_RETRY_MS = 250;

export interface PathPacing {
  /** The protocol's rules always, and the relay rate while the path is relayed or not yet known. */
  readonly pacing: Pacing;
  /** True for a relayed pair, false for a direct one, undefined until the pair is known. */
  readonly relayed: boolean | undefined;
  setRelayed(relayed: boolean | undefined): void;
}

/**
 * Pacing that follows the path. Until the pair has been read it is paced, because pacing a send that turns
 * out to be direct costs a moment, while not pacing one that is relayed costs the whole send. Switching to
 * direct stops pacing and forgets the bucket, so a long unpaced stretch is not held against a later one.
 */
export function createPathPacing(options: RatePacerOptions = {}): PathPacing {
  const rate = createRatePacer(options);
  const relayedRule = stricter(protocolPacing, rate.pacing);
  let relayed: boolean | undefined;
  return {
    get relayed(): boolean | undefined {
      return relayed;
    },
    setRelayed(next): void {
      if (next === false && relayed !== false) rate.reset();
      relayed = next;
    },
    pacing(state) {
      if (relayed === false) return protocolPacing(state);
      const verdict = relayedRule(state);
      // While the pair is unknown nothing tells the sender when it becomes known, so it asks again soon.
      if (relayed === undefined && verdict.bytes === 0) return { bytes: 0, retryMs: Math.min(verdict.retryMs ?? UNKNOWN_RETRY_MS, UNKNOWN_RETRY_MS) };
      return verdict;
    },
  };
}

export interface PathWatchOptions {
  /** How long to wait before asking again while no pair is selected. */
  readonly retryMs?: number;
  readonly maxRetries?: number;
  /** After an ICE restart the pair can change once the new checks settle, so it is read again at these delays. */
  readonly settleMs?: readonly number[];
}

export interface PathWatch {
  /** Reads the pair now; if there is none yet, keeps asking until there is (or the limit). */
  refresh(): Promise<void>;
  /** Reads the pair now and again as the restart settles. */
  afterRestart(): void;
  stop(): void;
}

/**
 * Keeps `apply` told whether the selected pair is relayed: once connected and again after each ICE restart.
 * A failed read leaves the last answer standing.
 */
export function watchPath(
  read: () => Promise<boolean | undefined>,
  apply: (relayed: boolean | undefined) => void,
  options: PathWatchOptions = {},
): PathWatch {
  const retryMs = options.retryMs ?? 300;
  const maxRetries = options.maxRetries ?? 30;
  const settleMs = options.settleMs ?? [1500, 5000];
  let stopped = false;
  // Retries while no pair is selected, and the later looks after a restart, are cleared separately.
  const retries = new Set<ReturnType<typeof setTimeout>>();
  const settles = new Set<ReturnType<typeof setTimeout>>();
  let generation = 0;

  const readOnce = async (): Promise<boolean | undefined> => {
    try {
      const relayed = await read();
      if (!stopped && relayed !== undefined) apply(relayed);
      return relayed;
    } catch {
      return undefined;
    }
  };
  const schedule = (timers: Set<ReturnType<typeof setTimeout>>, delay: number, work: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!stopped) work();
    }, delay);
    timers.add(timer);
  };
  const clear = (timers: Set<ReturnType<typeof setTimeout>>): void => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };

  async function refresh(): Promise<void> {
    clear(retries);
    generation += 1;
    const mine = generation;
    const relayed = await readOnce();
    if (relayed !== undefined) return;
    let attempts = 0;
    const again = (): void => {
      if (mine !== generation || attempts >= maxRetries) return;
      attempts += 1;
      void readOnce().then((result) => {
        if (result === undefined) schedule(retries, retryMs, again);
      });
    };
    schedule(retries, retryMs, again);
  }

  return {
    refresh,
    afterRestart(): void {
      clear(settles);
      void refresh();
      for (const delay of settleMs) schedule(settles, delay, () => void readOnce());
    },
    stop(): void {
      stopped = true;
      clear(retries);
      clear(settles);
    },
  };
}
