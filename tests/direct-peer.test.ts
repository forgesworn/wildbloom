import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectPeer, NoRelayError, buildRtcConfiguration, isRelayed, selectedPath, wrapDataChannel } from "../src/direct/peer.js";
import type { IceServer } from "../src/direct/messages.js";
import { FakeDataChannel, FakeRtc, installFakeRtc, settle } from "./helpers/direct-fakes.js";

const servers: IceServer[] = [
  {
    username: "1800003600:bGFiZWw",
    credential: "c2VjcmV0",
    urls: ["stun:turn.example.net:3478", "turn:turn.example.net:3478?transport=udp", "turns:turn.example.net:5349?transport=tcp"],
  },
  { username: "", credential: "", urls: ["stun:other.example.net:3478"] },
];

afterEach(() => vi.useRealTimers());

describe("the RTC configuration", () => {
  it("passes the invitation's servers and nothing else when the address is not hidden", () => {
    const configuration = buildRtcConfiguration(servers, false);
    expect(configuration.iceTransportPolicy).toBe("all");
    expect(configuration.iceServers).toEqual([
      { urls: servers[0]!.urls, username: servers[0]!.username, credential: servers[0]!.credential },
      { urls: servers[1]!.urls },
    ]);
    // A STUN-only entry has no credential keys at all.
    expect(Object.keys(configuration.iceServers![1]!)).toEqual(["urls"]);
    expect(configuration.bundlePolicy).toBe("max-bundle");
    expect(configuration.iceCandidatePoolSize).toBe(0);
  });

  it("hides the address with relay candidates only, drops STUN and drops a server with no TURN URL", () => {
    const configuration = buildRtcConfiguration(servers, true);
    expect(configuration.iceTransportPolicy).toBe("relay");
    expect(configuration.iceServers).toEqual([
      {
        urls: ["turn:turn.example.net:3478?transport=udp", "turns:turn.example.net:5349?transport=tcp"],
        username: servers[0]!.username,
        credential: servers[0]!.credential,
      },
    ]);
  });

  it("will not hide without a TURN server to hide behind", () => {
    expect(() => buildRtcConfiguration([servers[1]!], true)).toThrow(NoRelayError);
    expect(buildRtcConfiguration([servers[1]!], false).iceServers).toHaveLength(1);
  });

  it("will not hide with a STUN-only list, and hides behind the TURN URLs of mixed entries with their credentials", () => {
    expect(() => buildRtcConfiguration([servers[1]!], true)).toThrow(NoRelayError);
    const stunEntry: IceServer = { username: "", credential: "", urls: ["stun:s.example.net:3478"] };
    const turnEntry: IceServer = { username: "u", credential: "c", urls: ["turn:t.example.net:3478?transport=udp"] };
    const hidden = buildRtcConfiguration([stunEntry, turnEntry], true);
    expect(hidden.iceTransportPolicy).toBe("relay");
    expect(hidden.iceServers).toEqual([{ urls: turnEntry.urls, username: "u", credential: "c" }]);
  });

  it("does not change the list it was given", () => {
    const urls = [...servers[0]!.urls];
    buildRtcConfiguration(servers, true);
    expect(servers[0]!.urls).toEqual(urls);
  });
});

describe("a peer connection", () => {
  const make = (extra: { hide?: boolean; gatherMs?: number } = {}) => {
    const rtc = installFakeRtc();
    const peer = new DirectPeer({ iceServers: servers, hide: extra.hide ?? false, ...(extra.gatherMs === undefined ? {} : { gatherMs: extra.gatherMs }), rtc });
    return { peer, fake: FakeRtc.last() };
  };

  it("tries again without the ?transport=tcp spelling where the browser refuses it, and never adds a server", () => {
    const rtc = installFakeRtc();
    FakeRtc.rejectTcpSpelling = true;
    const withTcp: IceServer[] = [{ username: "u", credential: "c", urls: ["turn:turn.example.net:3478?transport=udp", "turn:turn.example.net:3478?transport=tcp", "turns:turn.example.net:5349?transport=tcp"] }];
    const peer = new DirectPeer({ iceServers: withTcp, hide: false, rtc });
    expect(FakeRtc.last().configuration.iceServers).toEqual([{ urls: ["turn:turn.example.net:3478?transport=udp"], username: "u", credential: "c" }]);
    peer.close();
    // Hiding needs a TURN URL that is left; a server whose only URL was refused is dropped, and with none left the peer will not start.
    const onlyTcp: IceServer[] = [{ username: "u", credential: "c", urls: ["turn:turn.example.net:3478?transport=tcp"] }];
    expect(() => new DirectPeer({ iceServers: onlyTcp, hide: true, rtc })).toThrow(NoRelayError);
    // Another failure is not hidden.
    expect(() => new DirectPeer({ iceServers: withTcp, hide: false, rtc: class { constructor() { throw new TypeError("no"); } } as unknown as typeof RTCPeerConnection })).toThrow(TypeError);
  });

  it("opens exactly one pre-negotiated, ordered, reliable data channel", () => {
    const { fake } = make();
    expect(fake.channels).toHaveLength(1);
    expect(fake.channels[0]!.label).toBe("wildbloom-direct/1");
    expect(fake.channels[0]!.init).toEqual({ negotiated: true, id: 0, ordered: true });
    expect(fake.channels[0]!.binaryType).toBe("arraybuffer");
  });

  it("returns the offer once gathering completes", async () => {
    const { peer, fake } = make();
    expect(await peer.offer()).toBe("offer-1+candidates");
    expect(fake.offers).toEqual([undefined]);
  });

  it("sends the description as it stands when gathering is still going after the limit", async () => {
    vi.useFakeTimers();
    const { peer, fake } = make({ gatherMs: 3000 });
    fake.autoGather = false;
    let result: string | undefined;
    const pending = peer.offer().then((sdp) => { result = sdp; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(result).toBe("offer-1+candidates");
  });

  it("asks for an ICE restart on the same connection and waits for the new gathering, not the old", async () => {
    const { peer, fake } = make();
    await peer.offer();
    expect(fake.iceGatheringState).toBe("complete");
    fake.autoGather = false;
    let result: string | undefined;
    const pending = peer.offer(true).then((sdp) => { result = sdp; });
    await settle(20);
    // The previous round's "complete" must not count: no new candidates have arrived.
    expect(result).toBeUndefined();
    expect(fake.offers.at(-1)).toEqual({ iceRestart: true });
    fake.finishGathering();
    await pending;
    expect(result).toBe("offer-2+candidates");
    expect(fake.channels).toHaveLength(1);
  });

  it("answers an offer, and answers a restart offer on the same connection", async () => {
    const { peer, fake } = make();
    expect(await peer.answer("the-offer")).toBe("answer-1+candidates");
    expect(fake.remoteDescription).toEqual({ type: "offer", sdp: "the-offer" });
    expect(await peer.answer("the-restart")).toBe("answer-2+candidates");
    expect(fake.remoteDescription).toEqual({ type: "offer", sdp: "the-restart" });
  });

  it("applies an answer", async () => {
    const { peer, fake } = make();
    await peer.offer();
    await peer.applyAnswer("the-answer");
    expect(fake.remoteDescription).toEqual({ type: "answer", sdp: "the-answer" });
  });

  it("resolves the channel when it opens and rejects it if the peer closes first", async () => {
    const opened = make();
    const channel = opened.peer.channel;
    opened.fake.channels[0]!.openNow();
    expect((await channel).open).toBe(true);

    const closed = make();
    const waiting = closed.peer.channel;
    closed.peer.close();
    await expect(waiting).rejects.toThrow(/closed before it opened/u);
    expect(closed.fake.closed).toBe(true);
    expect(closed.peer.state).toBe("closed");
    closed.peer.close();
  });

  it("reports state changes and treats a second data channel or a track as a violation that closes the peer", () => {
    const { peer, fake } = make();
    const seen: [string, boolean][] = [];
    const stop = peer.onState((state, violation) => seen.push([state, violation]));
    fake.setState("connecting");
    fake.setState("disconnected");
    expect(seen).toEqual([["connecting", false], ["disconnected", false]]);
    fake.dispatch("datachannel", { channel: {} });
    expect(seen.at(-1)).toEqual(["closed", true]);
    expect(seen).toHaveLength(3);
    expect(fake.closed).toBe(true);
    stop();
    fake.setState("failed");
    expect(seen).toHaveLength(3);

    const other = make();
    const events: boolean[] = [];
    other.peer.onState((_state, violation) => events.push(violation));
    other.fake.dispatch("track", {});
    expect(events.at(-1)).toBe(true);
    expect(other.fake.closed).toBe(true);
  });

  it("falls back to the ICE state where the browser has no connection state", () => {
    const { peer, fake } = make();
    fake.connectionState = undefined;
    const seen: string[] = [];
    peer.onState((state) => seen.push(state));
    for (const state of ["checking", "connected", "completed", "disconnected", "failed", "closed", "new"]) {
      fake.iceConnectionState = state;
      fake.dispatch("iceconnectionstatechange");
    }
    expect(seen).toEqual(["connecting", "connected", "connected", "disconnected", "failed", "closed", "new"]);
  });

  it("names the kinds of the selected pair, in Chrome's and Firefox's shapes", async () => {
    const { peer, fake } = make();
    fake.stats = {
      T: { type: "transport", selectedCandidatePairId: "P" },
      P: { type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R" },
      L: { type: "local-candidate", candidateType: "relay" },
      R: { type: "remote-candidate", candidateType: "host" },
    };
    expect(await peer.path()).toEqual({ local: "relay", remote: "host" });
    fake.stats = {
      P: { type: "candidate-pair", nominated: true, state: "succeeded", localCandidateId: "L", remoteCandidateId: "R" },
      L: { type: "local-candidate", candidateType: "srflx" },
      R: { type: "remote-candidate", candidateType: "relay" },
    };
    expect(await peer.path()).toEqual({ local: "srflx", remote: "relay" });
    fake.stats = {};
    expect(await peer.path()).toBeUndefined();
  });
});

describe("whether the selected pair is relayed", () => {
  const stats = (local: string, remote: string) => {
    const reports = [
      { id: "T", type: "transport", selectedCandidatePairId: "P" },
      { id: "P", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R" },
      { id: "L", type: "local-candidate", candidateType: local },
      { id: "R", type: "remote-candidate", candidateType: remote },
    ];
    return { forEach: (callback: (report: (typeof reports)[number]) => void) => reports.forEach(callback) };
  };

  it("is true when either end is a relay candidate, false when neither is, and unknown with no pair", () => {
    expect(isRelayed(selectedPath(stats("relay", "host")))).toBe(true);
    expect(isRelayed(selectedPath(stats("host", "relay")))).toBe(true);
    expect(isRelayed(selectedPath(stats("relay", "relay")))).toBe(true);
    expect(isRelayed(selectedPath(stats("host", "host")))).toBe(false);
    expect(isRelayed(selectedPath(stats("srflx", "prflx")))).toBe(false);
    expect(isRelayed(selectedPath({ forEach: () => undefined }))).toBeUndefined();
    expect(isRelayed(undefined)).toBeUndefined();
  });

  it("reads Firefox's shape, where the pair says it is selected", () => {
    const reports = [
      { id: "P", type: "candidate-pair", selected: true, localCandidateId: "L", remoteCandidateId: "R" },
      { id: "L", type: "local-candidate", candidateType: "host" },
      { id: "R", type: "remote-candidate", candidateType: "relay" },
    ];
    expect(isRelayed(selectedPath({ forEach: (callback) => reports.forEach(callback) }))).toBe(true);
  });

  it("is what the peer reports from its own statistics", async () => {
    const rtc = installFakeRtc();
    const peer = new DirectPeer({ iceServers: servers, hide: false, rtc });
    FakeRtc.last().stats = {
      T: { type: "transport", selectedCandidatePairId: "P" },
      P: { type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R" },
      L: { type: "local-candidate", candidateType: "relay" },
      R: { type: "remote-candidate", candidateType: "host" },
    };
    expect(await peer.relayed()).toBe(true);
    FakeRtc.last().stats = {};
    expect(await peer.relayed()).toBeUndefined();
  });
});

describe("the data channel adapter", () => {
  const adapt = (sctp?: { maxMessageSize: number } | null) => {
    const channel = new FakeDataChannel("wildbloom-direct/1", {});
    const frames = wrapDataChannel(channel as unknown as RTCDataChannel, sctp === undefined ? {} : { sctp });
    return { channel, frames };
  };

  it("takes the connection's maximum message size, or SCTP's 65,536 when it is not known", () => {
    expect(adapt().frames.maxMessageSize).toBe(65_536);
    expect(adapt(null).frames.maxMessageSize).toBe(65_536);
    expect(adapt({ maxMessageSize: 262_144 }).frames.maxMessageSize).toBe(262_144);
  });

  it("passes the buffer, its threshold, sends and closes", () => {
    const { channel, frames } = adapt();
    channel.bufferedAmount = 5;
    expect(frames.bufferedAmount).toBe(5);
    frames.bufferedAmountLowThreshold = 262_144;
    expect(channel.bufferedAmountLowThreshold).toBe(262_144);
    expect(frames.bufferedAmountLowThreshold).toBe(262_144);
    expect(frames.open).toBe(false);
    channel.openNow();
    expect(frames.open).toBe(true);
    frames.send(Uint8Array.of(1));
    expect(channel.sent).toEqual([Uint8Array.of(1)]);
    frames.close();
    expect(channel.readyState).toBe("closed");
  });

  it("delivers binary messages, reads a text message as an empty one, and reports low and closed", () => {
    const { channel, frames } = adapt();
    const got: Uint8Array[] = [];
    let low = 0;
    let closed = 0;
    const stop = frames.listen({ frame: (bytes) => got.push(bytes), low: () => { low += 1; }, closed: () => { closed += 1; } });
    channel.dispatch("message", { data: Uint8Array.of(7, 8).buffer });
    channel.dispatch("message", { data: "text" });
    channel.dispatch("bufferedamountlow");
    channel.dispatch("close");
    channel.dispatch("error");
    expect(got.map((bytes) => Array.from(bytes))).toEqual([[7, 8], []]);
    expect(low).toBe(1);
    expect(closed).toBe(2);
    stop();
    channel.dispatch("message", { data: Uint8Array.of(1).buffer });
    expect(got).toHaveLength(2);
  });
});
