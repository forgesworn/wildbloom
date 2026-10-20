import { LIMITS } from "../../src/direct/config.js";
import type { PeerOptions, PeerState } from "../../src/direct/peer.js";
import type { MessageExchange, PeerFactory, PeerLike } from "../../src/direct/session.js";
import type { ChannelHandlers, FrameChannel } from "../../src/direct/transfer.js";

/**
 * An in-memory data channel for tests. Frames sent on one end reach the other
 * in order. In manual mode they wait in the "wire" until `flush`, which models
 * the send buffer: `bufferedAmount` counts bytes not yet delivered, and
 * `bufferedamountlow` fires as it drains through the threshold.
 */
export class FakeChannel implements FrameChannel {
  open = true;
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  maxMessageSize: number;
  /** Every frame this end sent, in order, as sent. */
  readonly sent: Uint8Array[] = [];
  /** The most the buffer ever held. */
  peakBuffered = 0;
  peer!: FakeChannel;
  private readonly handlers = new Set<ChannelHandlers>();
  private wire: Uint8Array[] = [];
  private scheduled = false;
  auto: boolean;
  /** When true, frames wait on the wire even in auto mode, as on a path that has gone quiet. */
  stalled = false;

  constructor(options: { maxMessageSize?: number; auto?: boolean } = {}) {
    this.maxMessageSize = options.maxMessageSize ?? 262_144;
    this.auto = options.auto ?? true;
  }

  send(frame: Uint8Array): void {
    if (!this.open) throw new Error("The channel is closed.");
    const copy = frame.slice();
    this.sent.push(copy);
    this.wire.push(copy);
    this.bufferedAmount += copy.length;
    this.peakBuffered = Math.max(this.peakBuffered, this.bufferedAmount);
    if (this.auto && !this.stalled && !this.scheduled) {
      this.scheduled = true;
      setTimeout(() => { this.scheduled = false; this.flush(); }, 0);
    }
  }

  /** Delivers up to `limit` frames from the wire, then fires `low` if the buffer drained through the threshold. */
  flush(limit = Number.POSITIVE_INFINITY): number {
    const wasAbove = this.bufferedAmount > this.bufferedAmountLowThreshold;
    let delivered = 0;
    while (this.wire.length > 0 && delivered < limit && this.open) {
      const frame = this.wire.shift()!;
      this.bufferedAmount -= frame.length;
      delivered += 1;
      this.peer.receive(frame);
    }
    if (wasAbove && this.bufferedAmount <= this.bufferedAmountLowThreshold) for (const handler of [...this.handlers]) handler.low();
    return delivered;
  }

  /** Frames waiting on the wire. */
  get inFlight(): number {
    return this.wire.length;
  }

  receive(frame: Uint8Array): void {
    for (const handler of [...this.handlers]) handler.frame(frame);
  }

  /** Delivers a frame as if the other end sent it, without it being in `peer.sent`. */
  inject(frame: Uint8Array): void {
    this.receive(frame);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.wire = [];
    for (const handler of [...this.handlers]) handler.closed();
    if (this.peer.open) this.peer.close();
  }

  listen(handlers: ChannelHandlers): () => void {
    this.handlers.add(handlers);
    return () => { this.handlers.delete(handlers); };
  }
}

export function channelPair(options: { maxMessageSize?: number; auto?: boolean } = {}): [FakeChannel, FakeChannel] {
  const first = new FakeChannel(options);
  const second = new FakeChannel(options);
  first.peer = second;
  second.peer = first;
  return [first, second];
}

/** Lets timers and promise chains run. */
export const settle = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until the condition holds, however slowly the machine (or coverage instrumentation) runs. */
export async function waitUntil(condition: () => boolean, description: string, limitMs = 20_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
    await settle(5);
  }
}

/** Waits until the value has not changed for `quietMs`, and returns it: the point where something has stopped. */
export async function waitStable(read: () => number, description: string, quietMs = 150, limitMs = 20_000): Promise<number> {
  const deadline = Date.now() + limitMs;
  let last = read();
  let since = Date.now();
  while (Date.now() - since < quietMs) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description} to settle.`);
    await settle(10);
    const now = read();
    if (now !== last) {
      last = now;
      since = Date.now();
    }
  }
  return last;
}

export const MAX_FRAME = LIMITS.frameBytes;

// ---------------------------------------------------------------- fake WebRTC

type Listener = (event: unknown) => void;

class Target {
  private readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string, event: unknown = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

export class FakeDataChannel extends Target {
  readyState = "connecting";
  binaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: unknown[] = [];
  constructor(readonly label: string, readonly init: Record<string, unknown>) {
    super();
  }
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatch("close");
  }
  openNow(): void {
    this.readyState = "open";
    this.dispatch("open");
  }
}

export interface FakeStats {
  readonly [id: string]: Record<string, unknown>;
}

/** A stand-in for RTCPeerConnection that records what the peer asks of it and lets a test drive the events. */
export class FakeRtc extends Target {
  static instances: FakeRtc[] = [];
  static last(): FakeRtc {
    return FakeRtc.instances.at(-1)!;
  }
  connectionState: string | undefined = "new";
  iceConnectionState = "new";
  iceGatheringState = "new";
  sctp: { maxMessageSize: number } | null = null;
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  channels: FakeDataChannel[] = [];
  offers: unknown[] = [];
  closed = false;
  /** When true, `setLocalDescription` is followed by end-of-candidates on the next tick. */
  autoGather = true;
  stats: FakeStats = {};
  private round = 0;

  /** When true, a configuration with a `?transport=tcp` URL is refused as malformed, as WebKit does. */
  static rejectTcpSpelling = false;

  constructor(readonly configuration: Record<string, unknown>) {
    super();
    const urls = ((configuration.iceServers as { urls: string[] }[] | undefined) ?? []).flatMap((server) => server.urls);
    if (FakeRtc.rejectTcpSpelling && urls.some((url) => /\?transport=tcp$/iu.test(url))) {
      throw Object.assign(new Error("Malformed URL"), { name: "SyntaxError" });
    }
    FakeRtc.instances.push(this);
  }

  createDataChannel(label: string, init: Record<string, unknown>): FakeDataChannel {
    const channel = new FakeDataChannel(label, init);
    this.channels.push(channel);
    return channel;
  }

  async createOffer(options?: unknown): Promise<{ type: string; sdp: string }> {
    this.offers.push(options);
    this.round += 1;
    return { type: "offer", sdp: `offer-${this.round}` };
  }

  async createAnswer(): Promise<{ type: string; sdp: string }> {
    this.round += 1;
    return { type: "answer", sdp: `answer-${this.round}` };
  }

  async setLocalDescription(description: { type: string; sdp: string }): Promise<void> {
    this.localDescription = { type: description.type, sdp: `${description.sdp}+candidates` };
    this.iceGatheringState = "gathering";
    if (this.autoGather) setTimeout(() => this.finishGathering(), 0);
  }

  async setRemoteDescription(description: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = description;
  }

  finishGathering(): void {
    this.iceGatheringState = "complete";
    this.dispatch("icecandidate", { candidate: null });
    this.dispatch("icegatheringstatechange");
  }

  setState(state: string): void {
    this.connectionState = state;
    this.dispatch("connectionstatechange");
  }

  async getStats(): Promise<{ forEach(callback: (report: Record<string, unknown> & { id: string }) => void): void }> {
    const reports = Object.entries(this.stats).map(([id, report]) => ({ id, ...report }));
    return { forEach: (callback) => reports.forEach(callback) };
  }

  close(): void {
    this.closed = true;
    this.connectionState = this.connectionState === undefined ? undefined : "closed";
  }
}

export function installFakeRtc(): typeof RTCPeerConnection {
  FakeRtc.instances = [];
  FakeRtc.rejectTcpSpelling = false;
  return FakeRtc as unknown as typeof RTCPeerConnection;
}

// ------------------------------------------------------ fake exchange and peers


function transportError(kind: string): Error {
  return Object.assign(new Error(`exchange ${kind}`), { name: "ForegatherTransportError", kind });
}

/** One end of an in-memory foregather-exchange/1 channel. */
export class MemoryExchange implements MessageExchange {
  peer!: MemoryExchange;
  /** Every message this end sent, in order. */
  readonly sent: Uint8Array[] = [];
  private inbox: Uint8Array[] = [];
  private waiting: { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void } | undefined;
  private ended: string | undefined;
  /** Hold back everything this end sends until `release()`. */
  holding = false;
  private held: Uint8Array[] = [];
  /** Keep each send in flight until `flush()`. Ending this end meanwhile cancels it, as it does a relay request. */
  slow = false;
  private inFlight: { copy: Uint8Array; resolve: () => void; reject: (error: Error) => void }[] = [];

  async send(payload: Uint8Array): Promise<void> {
    if (this.ended) throw transportError(this.ended);
    const copy = payload.slice();
    if (this.slow) {
      await new Promise<void>((resolve, reject) => this.inFlight.push({ copy, resolve, reject }));
      return;
    }
    this.sent.push(copy);
    if (this.holding) this.held.push(copy);
    else this.peer.deliver(copy);
  }

  /** Lets every send in flight arrive. */
  flush(): void {
    this.slow = false;
    for (const { copy, resolve } of this.inFlight.splice(0)) {
      this.sent.push(copy);
      this.peer.deliver(copy);
      resolve();
    }
  }

  /** How many sends are in flight. */
  get sending(): number {
    return this.inFlight.length;
  }

  release(): void {
    this.holding = false;
    for (const bytes of this.held.splice(0)) this.peer.deliver(bytes);
  }

  deliver(bytes: Uint8Array): void {
    if (this.ended) return;
    if (this.waiting) {
      const { resolve } = this.waiting;
      this.waiting = undefined;
      resolve(bytes);
    } else this.inbox.push(bytes);
  }

  receive(): Promise<Uint8Array> {
    if (this.ended) return Promise.reject(transportError(this.ended));
    const next = this.inbox.shift();
    if (next) return Promise.resolve(next);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  close(): void {
    this.end("closed");
  }

  /** The session deadline passes at both ends. */
  expire(): void {
    this.end("expired");
    this.peer.end("expired");
  }

  end(kind: string): void {
    if (this.ended) return;
    this.ended = kind;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.reject(transportError(kind));
    for (const { reject } of this.inFlight.splice(0)) reject(transportError(kind));
  }

  get isEnded(): boolean {
    return this.ended !== undefined;
  }
}

export function exchangePair(): [MemoryExchange, MemoryExchange] {
  const drop = new MemoryExchange();
  const page = new MemoryExchange();
  drop.peer = page;
  page.peer = drop;
  return [drop, page];
}

export const FAKE_SDP = (tag: string): string =>
  `v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA:BB:CC\r\na=tag:${tag}\r\n`;

/** One fake peer connection. The network below connects it to the other end. */
export class FakePeer implements PeerLike {
  state: PeerState = "new";
  readonly calls: string[] = [];
  /** How many times the sender asked which kind of pair it was on. */
  relayedReads = 0;
  private readonly listeners = new Set<(state: PeerState, violation: boolean) => void>();
  readonly channel: Promise<FakeChannel>;
  private resolveChannel!: (channel: FakeChannel) => void;
  closedAt: number | undefined;

  constructor(readonly role: "offerer" | "answerer", readonly network: FakeNetwork, readonly options: PeerOptions) {
    this.channel = new Promise((resolve) => { this.resolveChannel = resolve; });
    this.channel.catch(() => undefined);
  }

  async offer(restart = false): Promise<string> {
    this.calls.push(restart ? "offer-restart" : "offer");
    return FAKE_SDP(`${this.role}-${this.calls.length}`);
  }

  async answer(offerSdp: string): Promise<string> {
    this.calls.push("answer");
    expectSdp(offerSdp);
    return FAKE_SDP(`${this.role}-${this.calls.length}`);
  }

  async applyAnswer(answerSdp: string): Promise<void> {
    expectSdp(answerSdp);
    this.calls.push("apply");
    this.network.answerApplied(this);
  }

  async relayed(): Promise<boolean | undefined> {
    this.relayedReads += 1;
    return this.network.readRelayed();
  }

  onState(listener: (state: PeerState, violation: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setState(state: PeerState): void {
    if (this.state === "closed") return;
    this.state = state;
    for (const listener of [...this.listeners]) listener(state, false);
  }

  openChannel(channel: FakeChannel): void {
    this.resolveChannel(channel);
  }

  close(): void {
    if (this.state === "closed") return;
    this.closedAt = Date.now();
    this.setState("closed");
    this.network.peerClosed(this);
  }
}

function expectSdp(sdp: string): void {
  if (!sdp.startsWith("v=0\r\n")) throw new Error("not an SDP");
}

/** Two fake peers joined by a pair of fake channels, and the switches a test needs to break and mend the path. */
export class FakeNetwork {
  readonly offerer: { channel: FakeChannel; peer?: FakePeer };
  readonly answerer: { channel: FakeChannel; peer?: FakePeer };
  readonly created: PeerOptions[] = [];
  /** What `getStats()` would say about the selected pair: relayed, direct, or not yet known. */
  relayedPath: boolean | undefined = false;
  /** Answers for the next reads, in order, before `relayedPath` takes over: "unknown twice, then direct" with no clock. */
  relayedScript: (boolean | undefined)[] = [];

  readRelayed(): boolean | undefined {
    return this.relayedScript.length > 0 ? this.relayedScript.shift() : this.relayedPath;
  }
  /** When set, the next `createPeer` for that role throws it, as the real peer does for a hide with nothing to hide behind. */
  failNextCreate: Error | undefined;
  private applied = 0;
  /** When false, a restart answer does not bring the path back, as when the other network is still down. */
  mendOnRestart = true;

  constructor(channelOptions: { maxMessageSize?: number; auto?: boolean } = {}) {
    const [offererChannel, answererChannel] = channelPair(channelOptions);
    this.offerer = { channel: offererChannel };
    this.answerer = { channel: answererChannel };
  }

  factory(role: "offerer" | "answerer"): PeerFactory {
    return (options) => {
      if (this.failNextCreate) {
        const error = this.failNextCreate;
        this.failNextCreate = undefined;
        throw error;
      }
      this.created.push(options);
      const peer = new FakePeer(role, this, options);
      this[role].peer = peer;
      return peer;
    };
  }

  /** The offerer applied an answer: the first one connects the two, a later one is a restart that mends the path. */
  answerApplied(peer: FakePeer): void {
    if (peer.role !== "offerer") return;
    this.applied += 1;
    queueMicrotask(() => {
      if (this.applied === 1) {
        this.offerer.peer?.openChannel(this.offerer.channel);
        this.answerer.peer?.openChannel(this.answerer.channel);
        this.setBoth("connected");
      } else if (this.mendOnRestart) {
        this.mendPath();
        this.setBoth("connected");
      }
    });
  }

  setBoth(state: PeerState): void {
    this.offerer.peer?.setState(state);
    this.answerer.peer?.setState(state);
  }

  /** The path goes quiet: frames wait, and both ends see `disconnected` then `failed`. */
  breakPath(state: "disconnected" | "failed" = "failed"): void {
    this.offerer.channel.stalled = true;
    this.answerer.channel.stalled = true;
    this.setBoth(state);
  }

  /** The path comes back (after a restart); held frames are delivered. */
  mendPath(): void {
    this.offerer.channel.stalled = false;
    this.answerer.channel.stalled = false;
    this.offerer.channel.flush();
    this.answerer.channel.flush();
  }

  peerClosed(peer: FakePeer): void {
    const side = this[peer.role];
    side.channel.close();
  }
}
