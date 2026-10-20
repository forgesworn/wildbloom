import { describe, expect, it } from "vitest";
import { newInputKey } from "../src/core/crypto.js";
import { decodeMessage, type DirectMessage, type IceServer, type Side } from "../src/direct/messages.js";
import { NoRelayError } from "../src/direct/peer.js";
import { createMemorySink, type MemorySink } from "../src/direct/sink.js";
import { DirectError, ReceiverSession, SenderSession, type DirectFailure } from "../src/direct/session.js";
import { decodeFrame } from "../src/direct/frames.js";
import { exchangePair, FakeNetwork, FAKE_SDP, settle, waitUntil, type MemoryExchange } from "./helpers/direct-fakes.js";

const ICE: IceServer[] = [{
  username: "1800003600:cGFnZQ",
  credential: "cGFnZS1jcmVkZW50aWFs",
  urls: ["stun:turn.example.net:3478", "turn:turn.example.net:3478?transport=udp", "turns:turn.example.net:5349?transport=tcp"],
}];
const DROP_ICE: IceServer[] = [{ ...ICE[0]!, username: "1800003600:ZHJvcA", credential: "ZHJvcC1jcmVkZW50aWFs" }];
const ALLOWLIST = ICE[0]!.urls;
const ID = "AAECAwQFBgcICQoLDA0ODw";
const MiB = 1_048_576;
const sample = (length: number): Uint8Array<ArrayBuffer> => Uint8Array.from({ length }, (_, index) => (index * 29 + (index >> 9)) & 0xff);

interface Rig {
  readonly network: FakeNetwork;
  readonly dropExchange: MemoryExchange;
  readonly pageExchange: MemoryExchange;
  readonly receiver: ReceiverSession;
  readonly sender: SenderSession;
}

function rig(options: { restartAfterMs?: number; giveUpMs?: number; connectMs?: number; hide?: boolean; rate?: { bytesPerSecond?: number; burstBytes?: number }; pathWatch?: { retryMs?: number; settleMs?: number[] } } = {}): Rig {
  const [dropExchange, pageExchange] = exchangePair();
  const network = new FakeNetwork();
  const receiver = new ReceiverSession({
    exchange: dropExchange,
    createPeer: network.factory("offerer"),
    restartAfterMs: options.restartAfterMs ?? 40,
    giveUpMs: options.giveUpMs ?? 300,
    connectMs: options.connectMs ?? 2000,
  });
  const sender = new SenderSession({
    exchange: pageExchange,
    iceAllowlist: ALLOWLIST,
    createPeer: network.factory("answerer"),
    giveUpMs: options.giveUpMs ?? 300,
    connectMs: options.connectMs ?? 2000,
    ...(options.rate ? { rate: options.rate } : {}),
    ...(options.pathWatch ? { pathWatch: options.pathWatch } : {}),
  });
  return { network, dropExchange, pageExchange, receiver, sender };
}

function decodeAll(exchange: MemoryExchange, from: Side): DirectMessage[] {
  return exchange.sent.map((bytes, index) => {
    const decoded = decodeMessage(bytes, { from, index, iceAllowlist: ALLOWLIST });
    if (!decoded.ok) throw new Error(`message ${index} from ${from} is not valid: ${decoded.detail}`);
    return decoded.message;
  });
}

async function rejects(promise: Promise<unknown>): Promise<DirectError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DirectError);
    return error as DirectError;
  }
  throw new Error("Expected a rejection.");
}
const kind = async (promise: Promise<unknown>): Promise<DirectFailure> => (await rejects(promise)).kind;

/** A promise whose rejection is handled at once, so one that settles before the test awaits it is not reported as unhandled. */
function quiet<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}
const send = (r: Rig, file: File, hooks: Parameters<SenderSession["send"]>[1]): Promise<void> => quiet(r.sender.send(file, hooks));
const accept = (r: Rig, hooks: Parameters<ReceiverSession["accept"]>[0]): Promise<void> => quiet(r.receiver.accept(hooks));

/** Invitation, manifest and the owner's answer, up to the point where the file moves. */
async function negotiate(r: Rig, file: File, options: { hide?: boolean; decide?: "accept" | "decline" } = {}) {
  await r.receiver.invitation({ dir: "to-drop", hide: options.hide ?? false, ice: ICE, id: ID, max: 250_000_000 });
  const invite = await r.sender.readInvite();
  const decision = quiet(r.sender.offer({ name: file.name, size: file.size, type: file.type }));
  const manifest = await r.receiver.readManifest();
  return { invite, decision, manifest };
}

function receiverHooks(extra: { sink?: { current?: MemorySink }; progress?: number[]; events?: string[]; hide?: boolean } = {}) {
  return {
    iceServers: DROP_ICE,
    hide: extra.hide ?? false,
    createSink: (transfer: { manifest: { name: string; size: number; type: string }; key: string; envelopeBytes: number }) => {
      const sink = createMemorySink({ key: transfer.key, manifest: transfer.manifest, envelopeBytes: transfer.envelopeBytes });
      if (extra.sink) extra.sink.current = sink;
      return sink;
    },
    onConnecting: () => extra.events?.push("drop:connecting"),
    onConnected: () => extra.events?.push("drop:connected"),
    onProgress: (written: number) => extra.progress?.push(written),
    onReconnecting: (on: boolean) => extra.events?.push(`drop:reconnecting:${on}`),
  };
}

describe("a whole direct send, page to Drop", () => {
  it("runs the messages in the protocol's order and moves the file", async () => {
    const r = rig();
    const bytes = sample(2 * MiB + 99);
    const file = new File([bytes], "Café holiday.mp4", { type: "video/mp4" });
    const events: string[] = [];
    const progress: number[] = [];
    const held: { current?: MemorySink } = {};

    const { invite, decision, manifest } = await negotiate(r, file);
    expect(invite).toMatchObject({ dir: "to-drop", hide: false, id: ID, max: 250_000_000 });
    expect(manifest).toMatchObject({ name: "Café holiday.mp4", size: bytes.length, type: "video/mp4" });
    // Neither end has a peer connection yet: nothing is exposed before the owner accepts.
    expect(r.network.created).toHaveLength(0);

    const receiving = accept(r, receiverHooks({ sink: held, progress, events }));
    expect(await decision).toBe("accepted");
    const sending = send(r, file, {
      hide: false,
      onConnecting: () => events.push("page:connecting"),
      onConnected: () => events.push("page:connected"),
      onProgress: (acknowledged, total) => events.push(`page:progress:${acknowledged === total ? "all" : "part"}`),
    });
    await Promise.all([sending, receiving]);

    expect(held.current?.file?.name).toBe("Café holiday.mp4");
    expect(Buffer.from(await held.current!.file!.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(progress.at(-1)).toBeGreaterThan(bytes.length);
    expect(events).toContain("page:connected");
    expect(events).toContain("drop:connected");
    expect(events.filter((event) => event.startsWith("page:progress")).at(-1)).toBe("page:progress:all");

    // Drop sent invite (0) and accept (1); the page sent manifest (0) and answer (1). Nothing else.
    expect(decodeAll(r.dropExchange, "drop").map((message) => message.event)).toEqual(["invite", "accept"]);
    const fromPage = decodeAll(r.pageExchange, "page");
    expect(fromPage.map((message) => message.event)).toEqual(["manifest", "answer"]);
    expect(fromPage[1]).toMatchObject({ event: "answer", key: expect.stringMatching(/^wbk1_/u) });

    // The page's peer used the invitation's servers, Drop's its own credential; each decided its own hiding.
    expect(r.network.created).toHaveLength(2);
    expect(r.network.answerer.peer!.options.iceServers).toEqual(ICE);
    expect(r.network.offerer.peer!.options.iceServers).toEqual(DROP_ICE);
    expect(r.network.answerer.peer!.state).toBe("closed");
    expect(r.network.offerer.peer!.state).toBe("closed");
    expect(r.dropExchange.isEnded && r.pageExchange.isEnded).toBe(true);
  }, 30_000);

  it("lets each end choose for itself whether to hide its address", async () => {
    const r = rig();
    const file = new File([sample(5000)], "a.bin", { type: "application/octet-stream" });
    const { decision } = await negotiate(r, file, { hide: true });
    const receiving = accept(r, receiverHooks({ hide: true }));
    await decision;
    const sending = send(r, file, { hide: false });
    await Promise.all([sending, receiving]);
    expect(r.network.offerer.peer!.options.hide).toBe(true);
    expect(r.network.answerer.peer!.options.hide).toBe(false);
  });

  it("creates no peer connection and sends nothing more when the owner declines", async () => {
    const r = rig();
    const file = new File([sample(5000)], "a.bin", { type: "application/octet-stream" });
    const { decision } = await negotiate(r, file);
    await r.receiver.decline();
    expect(await decision).toBe("declined");
    expect(r.network.created).toHaveLength(0);
    expect(decodeAll(r.dropExchange, "drop").map((message) => message.event)).toEqual(["invite", "decline"]);
    expect(decodeAll(r.pageExchange, "page").map((message) => message.event)).toEqual(["manifest"]);
    expect(r.dropExchange.isEnded && r.pageExchange.isEnded).toBe(true);
  });

  it("refuses a file larger than the receiver allows before offering it", async () => {
    const r = rig();
    await r.receiver.invitation({ dir: "to-drop", hide: false, ice: ICE, id: ID, max: 1000 });
    await r.sender.readInvite();
    expect(await kind(r.sender.offer({ name: "big.bin", size: 1001, type: "application/octet-stream" }))).toBe("too-big");
    expect(await kind(r.receiver.readManifest())).toBe("peer-cancelled");
    expect(r.network.created).toHaveLength(0);
  });

  it("stops with 'no-relay' when hiding is asked for and there is nothing to hide behind", async () => {
    const r = rig();
    const file = new File([sample(5000)], "a.bin", { type: "application/octet-stream" });
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks());
    receiving.catch(() => undefined);
    await decision;
    r.network.failNextCreate = new NoRelayError();
    expect(await kind(send(r, file, { hide: true }))).toBe("no-relay");
    // The other end is told and gives up.
    expect(["peer-failed", "lost", "peer-cancelled", "connect"]).toContain(await kind(receiving));
  });
});

describe("what the page refuses in an invitation", () => {
  async function offered(text: string): Promise<{ sender: SenderSession; drop: MemoryExchange; result: Promise<unknown> }> {
    const [dropExchange, pageExchange] = exchangePair();
    const sender = new SenderSession({ exchange: pageExchange, iceAllowlist: ALLOWLIST, createPeer: new FakeNetwork().factory("answerer") });
    await dropExchange.send(new TextEncoder().encode(text));
    return { sender, drop: dropExchange, result: sender.readInvite() };
  }
  const invite = (patch: Record<string, unknown>): string => {
    const base: Record<string, unknown> = { dir: "to-drop", event: "invite", hide: true, ice: [{ credential: "Y3JlZA", urls: ALLOWLIST, username: "dXNlcg" }], id: ID, max: 250_000_000, v: 1 };
    const merged = { ...base, ...patch };
    return JSON.stringify(Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1))));
  };

  it.each<[string, string, DirectFailure, string]>([
    ["a server it was not built for", invite({ ice: [{ credential: "Y3JlZA", urls: ["turn:evil.example:3478"], username: "dXNlcg" }] }), "unsupported", "unsupported"],
    ["a direction it does not implement", invite({ dir: "from-drop" }), "unsupported", "unsupported"],
    ["a size above the cap", invite({ max: 250_000_001 }), "unsupported", "unsupported"],
    ["a newer version", invite({ v: 2 }), "unsupported", "unsupported"],
    ["text that is not canonical", `${invite({})} `, "protocol", "failed"],
    ["a message that is not an invitation", '{"event":"stop","reason":"failed","v":1}', "protocol", "failed"],
  ])("answers %s with stop", async (_label, text, expectedKind, reason) => {
    const { drop, result } = await offered(text);
    expect(await kind(result)).toBe(expectedKind);
    await settle();
    const stop = decodeMessage(drop.peer.sent[0]!, { from: "page", index: 0, iceAllowlist: ALLOWLIST });
    expect(stop).toMatchObject({ ok: true, message: { event: "stop", reason } });
  });
});

describe("reconnection", () => {
  it("answers an ICE restart on the same connection and resends nothing", async () => {
    const r = rig();
    const bytes = sample(6 * MiB);
    const file = new File([bytes], "photo.jpg", { type: "image/jpeg" });
    const held: { current?: MemorySink } = {};
    const events: string[] = [];
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks({ sink: held, events }));
    await decision;
    let broke = false;
    const sending = send(r, file, {
      hide: false,
      onReconnecting: (on) => events.push(`page:reconnecting:${on}`),
      onProgress: (acknowledged) => {
        // The path goes quiet part of the way through, as when a phone changes network.
        if (!broke && acknowledged > 0) { broke = true; r.network.breakPath("failed"); }
      },
    });
    await Promise.all([sending, receiving]);

    expect(Buffer.from(await held.current!.file!.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect(events).toEqual(expect.arrayContaining(["page:reconnecting:true", "page:reconnecting:false", "drop:reconnecting:true", "drop:reconnecting:false"]));
    const fromDrop = decodeAll(r.dropExchange, "drop");
    const fromPage = decodeAll(r.pageExchange, "page");
    expect(fromDrop.map((message) => message.event)).toEqual(["invite", "accept", "restart"]);
    expect(fromPage.map((message) => message.event)).toEqual(["manifest", "answer", "restart-answer"]);
    expect(r.network.offerer.peer!.calls).toEqual(["offer", "apply", "offer-restart", "apply"]);
    expect(r.network.answerer.peer!.calls).toEqual(["answer", "answer"]);
    // One connection, one data channel: the transfer carried on. Every DATA offset is used once.
    const offsets = r.network.answerer.channel.sent.filter((frame) => frame[0] === 1).map((frame) => (decodeFrame("sender", frame) as { offset: number }).offset);
    expect(new Set(offsets).size).toBe(offsets.length);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  }, 30_000);

  it("restarts after a connection has stayed disconnected for the wait, and not before", async () => {
    const r = rig({ restartAfterMs: 120 });
    const file = new File([sample(4 * MiB)], "a.bin", { type: "application/octet-stream" });
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks());
    await decision;
    let brokeAt = 0;
    let restartsAtBreak = -1;
    const sending = send(r, file, {
      hide: false,
      onProgress: (acknowledged) => {
        if (brokeAt === 0 && acknowledged > 0) {
          brokeAt = Date.now();
          r.network.breakPath("disconnected");
          restartsAtBreak = r.receiver.restarts;
        }
      },
    });
    await waitUntil(() => r.receiver.restarts === 1, "the restart", 10_000);
    // A blip is not an end and not yet a restart: the restart came after the wait, not at the break.
    expect(restartsAtBreak).toBe(0);
    expect(Date.now() - brokeAt).toBeGreaterThanOrEqual(100);
    await Promise.all([sending, receiving]);
  }, 30_000);

  it("does not restart for a blip that mends itself", async () => {
    const r = rig({ restartAfterMs: 8_000 });
    const file = new File([sample(4 * MiB)], "a.bin", { type: "application/octet-stream" });
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks());
    await decision;
    let broke = false;
    const sending = send(r, file, {
      hide: false,
      onProgress: (acknowledged) => {
        if (broke || acknowledged === 0) return;
        broke = true;
        r.network.breakPath("disconnected");
        setTimeout(() => { r.network.mendPath(); r.network.setBoth("connected"); }, 30);
      },
    });
    await Promise.all([sending, receiving]);
    expect(r.receiver.restarts).toBe(0);
  }, 30_000);

  it("allows five restarts and no more", async () => {
    const r = rig();
    const file = new File([sample(6 * MiB)], "a.bin", { type: "application/octet-stream" });
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks());
    await decision;
    const sending = send(r, file, { hide: false });
    await settle(5);
    for (let round = 0; round < 5; round += 1) await r.receiver.restartIce().catch(() => undefined);
    const sixth = await rejects(r.receiver.restartIce());
    expect(["lost", "expired"]).toContain(sixth.kind);
    await Promise.allSettled([sending, receiving]);
    expect(r.receiver.restarts).toBeLessThanOrEqual(5);
  }, 30_000);

  it("gives up with 'lost' when a failed connection does not come back, on both ends, and deletes what was held", async () => {
    const r = rig({ giveUpMs: 120 });
    const file = new File([sample(6 * MiB)], "a.bin", { type: "application/octet-stream" });
    const held: { current?: MemorySink } = {};
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks({ sink: held }));
    await decision;
    r.network.mendOnRestart = false;
    let broke = false;
    const sending = send(r, file, {
      hide: false,
      onProgress: (acknowledged) => { if (!broke && acknowledged > 0) { broke = true; r.network.breakPath("failed"); } },
    });
    // The channel never reports a close: the end is driven by the connection state.
    expect(await kind(sending)).toBe("lost");
    expect(await kind(receiving)).toBe("lost");
    expect(held.current?.file).toBeUndefined();
    expect(r.network.answerer.peer!.state).toBe("closed");
  }, 30_000);

  it("ends a failed connection at once when the exchange is gone and no restart is possible", async () => {
    const r = rig({ giveUpMs: 60_000 });
    const file = new File([sample(6 * MiB)], "a.bin", { type: "application/octet-stream" });
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks());
    receiving.catch(() => undefined);
    await decision;
    let broke = false;
    const sending = send(r, file, {
      hide: false,
      onProgress: (acknowledged) => {
        if (broke || acknowledged === 0) return;
        broke = true;
        r.network.mendOnRestart = false;
        r.dropExchange.holding = true;
        r.pageExchange.expire();
        r.network.breakPath("failed");
      },
    });
    const started = Date.now();
    expect(await kind(sending)).toBe("lost");
    expect(Date.now() - started).toBeLessThan(5000);
    r.receiver.close();
  }, 30_000);

  it("gives up with 'connect' when the two never find a path", async () => {
    const r = rig({ connectMs: 80 });
    const file = new File([sample(5000)], "a.bin", { type: "application/octet-stream" });
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks());
    receiving.catch(() => undefined);
    await decision;
    // The offerer never gets to apply the answer in time.
    r.network.offerer.peer?.close;
    const originalApply = r.network.answerApplied.bind(r.network);
    r.network.answerApplied = () => undefined;
    const sending = send(r, file, { hide: false });
    expect(await kind(sending)).toBe("connect");
    r.network.answerApplied = originalApply;
    expect(await kind(receiving)).toBe("connect");
  }, 30_000);

  it("is not ended by the session deadline once the data channel is open", async () => {
    const r = rig();
    const file = new File([sample(5 * MiB)], "a.bin", { type: "application/octet-stream" });
    const held: { current?: MemorySink } = {};
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks({ sink: held }));
    await decision;
    let expired = false;
    const sending = send(r, file, {
      hide: false,
      onProgress: (acknowledged) => { if (!expired && acknowledged > 0) { expired = true; r.dropExchange.expire(); } },
    });
    await Promise.all([sending, receiving]);
    expect(held.current?.file?.size).toBe(file.size);
  }, 30_000);
});

describe("pacing a relayed send", () => {
  async function run(r: Rig, size: number, hooks: { onPath?: (relayed: boolean | undefined) => void; onProgress?: (acknowledged: number) => void } = {}): Promise<number> {
    const file = new File([sample(size)], "paced.bin", { type: "application/octet-stream" });
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks());
    await decision;
    const started = Date.now();
    await Promise.all([send(r, file, { hide: false, ...hooks }), receiving]);
    return Date.now() - started;
  }

  it("holds the send to the rate when the selected pair is relayed, and says what it found", async () => {
    const r = rig({ rate: { bytesPerSecond: 8_000_000, burstBytes: 65_536 } });
    r.network.relayedPath = true;
    const seen: (boolean | undefined)[] = [];
    const elapsed = await run(r, 3 * MiB, { onPath: (relayed) => seen.push(relayed) });
    expect(seen[0]).toBe(true);
    // 3 MiB and its padding at 8 MB/s cannot take less than this.
    expect(elapsed).toBeGreaterThanOrEqual(((3 * MiB - 65_536) / 8_000_000) * 1000 * 0.9);
  }, 30_000);

  it("does not pace a direct pair", async () => {
    // A paced send of 3 MiB at this rate would take more than two minutes, longer than the test is given:
    // it can only finish if the send ran free. That holds on a slow machine as on a fast one.
    const r = rig({ rate: { bytesPerSecond: 20_000, burstBytes: 65_536 } });
    r.network.relayedPath = false;
    const seen: (boolean | undefined)[] = [];
    await run(r, 3 * MiB, { onPath: (relayed) => seen.push(relayed) });
    expect(seen).toEqual([false]);
  }, 30_000);

  it("is paced until the pair is known, then follows what it finds", async () => {
    // The first reads find no pair; later ones find a direct one. No clock decides when: the count of reads does.
    const r = rig({ rate: { bytesPerSecond: 20_000, burstBytes: 65_536 }, pathWatch: { retryMs: 1 } });
    r.network.relayedScript = [undefined, undefined, undefined];
    r.network.relayedPath = false;
    const seen: (boolean | undefined)[] = [];
    // As above, it can only finish if pacing was switched off once the pair was found to be direct.
    await run(r, 3 * MiB, { onPath: (relayed) => seen.push(relayed) });
    // Nothing was reported while the pair was unknown; what was reported was direct, and never anything else.
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([false]));
    expect(seen.at(-1)).toBe(false);
    expect(r.network.relayedScript).toEqual([]);
  }, 30_000);

  it("reads the pair again after an ICE restart and paces if the send moved onto a relay", async () => {
    const r = rig({ rate: { bytesPerSecond: 4_000_000, burstBytes: 65_536 }, pathWatch: { retryMs: 20, settleMs: [10, 40] } });
    r.network.relayedPath = false;
    const seen: (boolean | undefined)[] = [];
    let broke = false;
    await run(r, 6 * MiB, {
      onPath: (relayed) => seen.push(relayed),
      onProgress: (acknowledged) => {
        if (broke || acknowledged === 0) return;
        broke = true;
        // The network changes under the send: when it comes back it is on a relay.
        r.network.relayedPath = true;
        r.network.breakPath("failed");
      },
    });
    expect(seen[0]).toBe(false);
    expect(seen.at(-1)).toBe(true);
    expect(r.receiver.restarts).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe("stopping", () => {
  it("tells the other end when the page cancels: STOP on the channel, a stop message, and the connection closed", async () => {
    const r = rig();
    const file = new File([sample(8 * MiB)], "a.bin", { type: "application/octet-stream" });
    const held: { current?: MemorySink } = {};
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks({ sink: held }));
    await decision;
    let stopped = false;
    const sending = send(r, file, {
      hide: false,
      onProgress: (acknowledged) => { if (!stopped && acknowledged > 0) { stopped = true; r.sender.stop("cancelled"); } },
    });
    expect(await kind(sending)).toBe("cancelled");
    expect(await kind(receiving)).toBe("peer-cancelled");
    expect(held.current?.file).toBeUndefined();
    expect(r.network.answerer.channel.sent.some((frame) => frame[0] === 5 && frame[1] === 1)).toBe(true);
    expect(r.network.answerer.peer!.state).toBe("closed");
    await settle(20);
    expect(decodeAll(r.pageExchange, "page").at(-1)).toEqual({ event: "stop", reason: "cancelled" });
  }, 30_000);

  it("closes the connection in the same turn when the page is being hidden, and Drop still learns", async () => {
    const r = rig();
    const file = new File([sample(8 * MiB)], "a.bin", { type: "application/octet-stream" });
    const held: { current?: MemorySink } = {};
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks({ sink: held }));
    await decision;
    let stopped = false;
    let closedInTurn: boolean | undefined;
    const sending = send(r, file, {
      hide: false,
      onProgress: (acknowledged) => {
        if (stopped || acknowledged === 0) return;
        stopped = true;
        r.sender.stop("cancelled", { immediate: true });
        closedInTurn = r.network.answerer.peer!.state === "closed";
      },
    });
    expect(await kind(sending)).toBe("cancelled");
    expect(closedInTurn).toBe(true);
    // Whether the STOP got out before the connection closed or the close alone told Drop, nothing is kept.
    expect(["peer-cancelled", "lost"]).toContain(await kind(receiving));
    expect(held.current?.file).toBeUndefined();
  }, 30_000);

  it("sends a stop message in place of the next one when cancelled before the file moves", async () => {
    const r = rig();
    const file = new File([sample(5000)], "a.bin", { type: "application/octet-stream" });
    await negotiate(r, file);
    r.sender.stop("cancelled");
    expect(await kind(r.receiver.readManifest().catch((error: unknown) => { throw error; }))).toBe("peer-cancelled");
  });

  it("ends the page's session when Drop sends a stop mid-transfer", async () => {
    const r = rig();
    const file = new File([sample(8 * MiB)], "a.bin", { type: "application/octet-stream" });
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks());
    receiving.catch(() => undefined);
    await decision;
    let stopped = false;
    const sending = send(r, file, {
      hide: false,
      onProgress: (acknowledged) => { if (!stopped && acknowledged > 0) { stopped = true; r.receiver.stop("cancelled", { immediate: true }); } },
    });
    expect(["peer-cancelled", "lost"]).toContain(await kind(sending));
    await Promise.allSettled([receiving]);
  }, 30_000);

  it("reports a sink that refuses the file as peer-failed on the page and 'verification' on Drop", async () => {
    const r = rig();
    const file = new File([sample(300_000)], "a.bin", { type: "application/octet-stream" });
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, {
      ...receiverHooks(),
      // A sink that was given another file's key cannot open this envelope.
      createSink: (transfer) => createMemorySink({ key: newInputKey(), manifest: transfer.manifest, envelopeBytes: transfer.envelopeBytes }),
    });
    await decision;
    const sending = send(r, file, { hide: false });
    expect(await kind(sending)).toBe("peer-failed");
    expect(await kind(receiving)).toBe("verification");
  }, 30_000);
});

describe("what each end refuses on the exchange", () => {
  it("fails a sixth restart with stop and 'protocol'", async () => {
    const r = rig();
    const file = new File([sample(8 * MiB)], "a.bin", { type: "application/octet-stream" });
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks());
    receiving.catch(() => undefined);
    await decision;
    let sent = false;
    const sending = send(r, file, {
      hide: false,
      onProgress: (acknowledged) => {
        if (sent || acknowledged === 0) return;
        sent = true;
        // Drop has used indexes 0 and 1; restarts at 2 to 6 are allowed, and a sixth at 7 is not.
        // The page's answers are held back so Drop's own end does not react to answers it never asked for.
        r.pageExchange.holding = true;
        for (let round = 0; round < 6; round += 1) {
          void r.dropExchange.send(new TextEncoder().encode(JSON.stringify({ event: "restart", sdp: FAKE_SDP(`r${round}`), v: 1 })));
        }
      },
    });
    expect(await kind(sending)).toBe("protocol");
    await settle(10);
    const fromPage = decodeAll(r.pageExchange, "page");
    expect(fromPage.map((message) => message.event)).toEqual(["manifest", "answer", "restart-answer", "restart-answer", "restart-answer", "restart-answer", "restart-answer", "stop"]);
    expect(fromPage.at(-1)).toEqual({ event: "stop", reason: "failed" });
    r.receiver.close();
  }, 30_000);

  it("fails a restart answer nobody asked for with 'protocol' on Drop", async () => {
    const r = rig();
    const file = new File([sample(8 * MiB)], "a.bin", { type: "application/octet-stream" });
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks());
    await decision;
    let sent = false;
    const sending = send(r, file, {
      hide: false,
      onProgress: (acknowledged) => {
        if (sent || acknowledged === 0) return;
        sent = true;
        void r.pageExchange.send(new TextEncoder().encode(JSON.stringify({ event: "restart-answer", sdp: FAKE_SDP("unasked"), v: 1 })));
      },
    });
    sending.catch(() => undefined);
    expect(await kind(receiving)).toBe("protocol");
  }, 30_000);

  it("refuses to send past message 7", async () => {
    const r = rig();
    const file = new File([sample(3 * MiB)], "a.bin", { type: "application/octet-stream" });
    const { decision } = await negotiate(r, file);
    const receiving = accept(r, receiverHooks());
    receiving.catch(() => undefined);
    await decision;
    const sending = send(r, file, { hide: false });
    sending.catch(() => undefined);
    await settle(5);
    // Drop has used messages 0 and 1; five restarts take 2 to 6; the one left is the stop.
    const outcomes = [];
    for (let round = 0; round < 6; round += 1) outcomes.push(await r.receiver.restartIce().then(() => "ok", (error: DirectError) => error.kind));
    expect(outcomes.filter((outcome) => outcome === "ok").length).toBeLessThanOrEqual(5);
    await Promise.allSettled([sending, receiving]);
  }, 30_000);
});
