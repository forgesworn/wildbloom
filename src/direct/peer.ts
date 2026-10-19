import { DATA_CHANNEL_LABEL, GATHER_MS, LIMITS } from "./config.js";
import type { IceServer } from "./messages.js";
import type { ChannelHandlers, FrameChannel } from "./transfer.js";

/**
 * One RTCPeerConnection with the protocol's one pre-negotiated data channel
 * (wildbloom-direct/1, "Data channel and frames" and "Session descriptions").
 * Descriptions are not trickled: each is returned once gathering completes or
 * three seconds after it starts, whichever comes first, ready to travel over
 * the word-verified exchange. Nothing here talks to a signalling server.
 */

export type PeerState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";

export interface PeerOptions {
  /** The ICE servers from the (allowlist-checked) invitation, and nothing else. */
  readonly iceServers: readonly IceServer[];
  /** Hide this device's own address: relay candidates only, and STUN is not contacted. */
  readonly hide: boolean;
  /** Overrides how long a description waits for gathering; tests use it. */
  readonly gatherMs?: number;
  /** Overrides the browser's constructor; tests use it. */
  readonly rtc?: typeof RTCPeerConnection;
}

/** Hiding needs a TURN server to hide behind. */
export class NoRelayError extends Error {
  constructor() {
    super("There is no TURN server to hide behind.");
    this.name = "NoRelayError";
  }
}

const isRelayUrl = (url: string): boolean => url.startsWith("turn:") || url.startsWith("turns:");

/**
 * The only configuration a peer is built from. Hiding keeps TURN URLs alone and
 * sets the relay-only policy, so the other device sees the TURN server's
 * address (and the TURN server still sees the real one). A server with no TURN
 * URL is dropped rather than left to turn a hidden connection into a direct one.
 */
export function buildRtcConfiguration(servers: readonly IceServer[], hide: boolean): RTCConfiguration {
  const iceServers: RTCIceServer[] = [];
  for (const server of servers) {
    const urls = hide ? server.urls.filter(isRelayUrl) : [...server.urls];
    if (urls.length === 0) continue;
    iceServers.push({ urls, username: server.username, credential: server.credential });
  }
  if (hide && iceServers.length === 0) throw new NoRelayError();
  return {
    iceServers,
    iceTransportPolicy: hide ? "relay" : "all",
    bundlePolicy: "max-bundle",
    iceCandidatePoolSize: 0,
  };
}

/** Adapts an `RTCDataChannel` to what the transfer needs. */
export function wrapDataChannel(channel: RTCDataChannel, connection: { readonly sctp?: { readonly maxMessageSize: number } | null }): FrameChannel {
  channel.binaryType = "arraybuffer";
  return {
    get open(): boolean {
      return channel.readyState === "open";
    },
    get bufferedAmount(): number {
      return channel.bufferedAmount;
    },
    get bufferedAmountLowThreshold(): number {
      return channel.bufferedAmountLowThreshold;
    },
    set bufferedAmountLowThreshold(value: number) {
      channel.bufferedAmountLowThreshold = value;
    },
    get maxMessageSize(): number {
      // SCTP's default when the other end does not say.
      return connection.sctp?.maxMessageSize ?? LIMITS.frameBytes;
    },
    send(frame: Uint8Array): void {
      channel.send(frame as Uint8Array<ArrayBuffer>);
    },
    close(): void {
      channel.close();
    },
    listen(handlers: ChannelHandlers): () => void {
      const onMessage = (event: MessageEvent): void => {
        // Only binary messages are part of the protocol; an empty one reads as a failure.
        handlers.frame(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : new Uint8Array(0));
      };
      const onLow = (): void => handlers.low();
      const onClose = (): void => handlers.closed();
      channel.addEventListener("message", onMessage);
      channel.addEventListener("bufferedamountlow", onLow);
      channel.addEventListener("close", onClose);
      channel.addEventListener("error", onClose);
      return () => {
        channel.removeEventListener("message", onMessage);
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClose);
        channel.removeEventListener("error", onClose);
      };
    },
  };
}

function stateOf(connection: RTCPeerConnection): PeerState {
  if (connection.connectionState !== undefined) return connection.connectionState;
  // Firefox before 113 has only the ICE state.
  switch (connection.iceConnectionState) {
    case "connected":
    case "completed": return "connected";
    case "disconnected": return "disconnected";
    case "failed": return "failed";
    case "closed": return "closed";
    case "checking": return "connecting";
    default: return "new";
  }
}

export class DirectPeer {
  /** Resolves with the open data channel; rejects if the peer is closed first. */
  readonly channel: Promise<FrameChannel>;
  private readonly connection: RTCPeerConnection;
  private readonly dataChannel: RTCDataChannel;
  private readonly gatherMs: number;
  private readonly listeners = new Set<(state: PeerState, violation: boolean) => void>();
  private gathered: (() => void) | undefined;
  private closed = false;
  private violated = false;

  constructor(options: PeerOptions) {
    const Constructor = options.rtc ?? RTCPeerConnection;
    this.gatherMs = options.gatherMs ?? GATHER_MS;
    this.connection = new Constructor(buildRtcConfiguration(options.iceServers, options.hide));
    // Negotiated on both sides, so no ondatachannel event ever carries the protocol's channel.
    this.dataChannel = this.connection.createDataChannel(DATA_CHANNEL_LABEL, { negotiated: true, id: 0, ordered: true });
    this.dataChannel.binaryType = "arraybuffer";
    this.connection.addEventListener("datachannel", () => this.violation());
    this.connection.addEventListener("track", () => this.violation());
    this.connection.addEventListener("connectionstatechange", () => this.emit());
    this.connection.addEventListener("iceconnectionstatechange", () => { if (this.connection.connectionState === undefined) this.emit(); });
    this.connection.addEventListener("icecandidate", (event) => { if (!event.candidate) this.gathered?.(); });
    this.connection.addEventListener("icegatheringstatechange", () => { if (this.connection.iceGatheringState === "complete") this.gathered?.(); });
    this.channel = new Promise<FrameChannel>((resolve, reject) => {
      const frames = wrapDataChannel(this.dataChannel, this.connection);
      if (this.dataChannel.readyState === "open") resolve(frames);
      this.dataChannel.addEventListener("open", () => resolve(frames));
      this.dataChannel.addEventListener("close", () => reject(new Error("The data channel closed before it opened.")));
    });
    // A rejection nobody awaits yet must not surface as unhandled.
    this.channel.catch(() => undefined);
  }

  get state(): PeerState {
    return this.closed ? "closed" : stateOf(this.connection);
  }

  /** Called with each connection state change; `violation` is true if the other end opened a channel or track the protocol forbids. */
  onState(listener: (state: PeerState, violation: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The offerer's description, once gathered. Pass `restart` for an ICE restart on the same connection. */
  async offer(restart = false): Promise<string> {
    return this.describe(async () => {
      const offer = await this.connection.createOffer(restart ? { iceRestart: true } : undefined);
      await this.connection.setLocalDescription(offer);
    });
  }

  /** The answerer's description for an offer (the first, or a restart), once gathered. */
  async answer(offerSdp: string): Promise<string> {
    await this.connection.setRemoteDescription({ type: "offer", sdp: offerSdp });
    return this.describe(async () => {
      const answer = await this.connection.createAnswer();
      await this.connection.setLocalDescription(answer);
    });
  }

  /** The offerer applies the answer, for the first round and for each restart. */
  async applyAnswer(answerSdp: string): Promise<void> {
    await this.connection.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  /** The kinds of the selected candidate pair, e.g. `{ local: "relay", remote: "relay" }`. For tests and diagnostics only. */
  async path(): Promise<{ readonly local: string; readonly remote: string } | undefined> {
    const stats = await this.connection.getStats();
    const reports = new Map<string, Record<string, unknown>>();
    stats.forEach((report: Record<string, unknown> & { id: string }) => reports.set(report.id, report));
    let pair: Record<string, unknown> | undefined;
    for (const report of reports.values()) {
      if (report.type === "transport" && typeof report.selectedCandidatePairId === "string") pair = reports.get(report.selectedCandidatePairId);
    }
    pair ??= [...reports.values()].find((report) => report.type === "candidate-pair" && (report.selected === true || (report.nominated === true && report.state === "succeeded")));
    if (!pair) return undefined;
    const kind = (id: unknown): string => String(reports.get(String(id))?.candidateType ?? "unknown");
    return { local: kind(pair.localCandidateId), remote: kind(pair.remoteCandidateId) };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.gathered?.();
    try {
      this.dataChannel.close();
    } finally {
      this.connection.close();
    }
    this.emit();
  }

  private violation(): void {
    this.violated = true;
    this.close();
  }

  private emit(): void {
    const state = this.state;
    for (const listener of [...this.listeners]) listener(state, this.violated);
  }

  /** Runs a step that sets the local description, then waits for gathering to complete or the clock to run out. */
  private async describe(step: () => Promise<void>): Promise<string> {
    let complete = false;
    let finish: (() => void) | undefined;
    this.gathered = () => {
      complete = true;
      finish?.();
    };
    try {
      await step();
      if (!complete) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.gatherMs);
          finish = () => {
            clearTimeout(timer);
            resolve();
          };
          // The gatherer may have finished while the step was resolving.
          if (complete) finish();
        });
      }
    } finally {
      this.gathered = undefined;
    }
    const sdp = this.connection.localDescription?.sdp;
    if (!sdp) throw new Error("The connection has no local description.");
    return sdp;
  }
}
