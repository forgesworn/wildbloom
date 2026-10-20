import { createLiveRelayClient, createPairingFlow, init, type LiveAllocation, type LiveSession, type PairingFlow } from "@forgesworn/foregather-kit";
import { sha256Hex } from "../../../src/core/crypto.js";
import { DirectPeer } from "../../../src/direct/peer.js";
import type { IceServer } from "../../../src/direct/messages.js";
import { DirectError, fromPairingExchange, ReceiverSession, type PeerFactory, type PeerLike } from "../../../src/direct/session.js";
import { createMemorySink } from "../../../src/direct/sink.js";

/**
 * The test receiver: Drop's part of a direct send, run in a second browser so
 * the acceptance script can drive two real browsers against a real pairing
 * service. It opens the session as the inviter, shows the check words, sends the
 * invitation, takes the manifest, accepts or declines on command, receives the
 * file into a memory sink and offers Save only once the file is verified.
 *
 * Nothing here logs a message payload: they carry a TURN credential and the key.
 */

export interface HarnessConfig {
  readonly relayApi: string;
  readonly session: LiveSession;
  readonly secretWords: string;
  readonly allocation: LiveAllocation;
  readonly namespace: string;
  readonly purpose: string;
  /** The servers and the page's credential, sent in the invitation. */
  readonly inviteIce: readonly IceServer[];
  /** Drop's own credential on the same servers. */
  readonly dropIce: readonly IceServer[];
  readonly hide: boolean;
  readonly max: number;
  readonly id: string;
  readonly gatherMs?: number;
  readonly restartAfterMs?: number;
  readonly giveUpMs?: number;
  /** When true, candidate addresses go through `__bridge.proxyFor` so the script can slow or cut the path. */
  readonly shim?: boolean;
}

interface Status {
  phase: string;
  checkWords: string;
  manifest: { name: string; size: number; type: string } | null;
  written: number;
  total: number;
  failure: string | null;
  kept: { name: string; size: number; type: string; sha256: string } | null;
  reconnecting: boolean;
  events: string[];
}

declare global {
  interface Window {
    __drop: unknown;
    __bridge?: { proxyFor(role: "drop" | "phone", ip: string, port: number): Promise<number> };
  }
}

const status: Status = { phase: "idle", checkWords: "", manifest: null, written: 0, total: 0, failure: null, kept: null, reconnecting: false, events: [] };
let flow: PairingFlow | undefined;
let receiver: ReceiverSession | undefined;
let config: HarnessConfig | undefined;
let saveUrl: string | undefined;

const text = (id: string, value: string): void => { document.getElementById(id)!.textContent = value; };
function note(event: string): void {
  status.events.push(`${Math.round(performance.now())} ${event}`);
  text("log", status.events.join("\n"));
}
function phase(next: string): void {
  status.phase = next;
  text("phase", next);
  note(`phase ${next}`);
}

// ------------------------------------------------------- the optional UDP shim

const CANDIDATE = /^a=candidate:(\S+) (\d+) (\S+) (\d+) (\S+) (\d+) typ (\S+)(.*)$/u;

/** Keeps IPv4 UDP host candidates and sends them through the script's proxies, so the path can be slowed or cut. */
async function throughShim(sdp: string, role: "drop" | "phone"): Promise<string> {
  const bridge = window.__bridge;
  if (!config?.shim || !bridge) return sdp;
  const lines = sdp.split("\r\n");
  const out: string[] = [];
  for (const line of lines) {
    const match = CANDIDATE.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const [, foundation, component, transport, priority, ip, port, type, rest] = match as unknown as string[];
    if (transport!.toLowerCase() !== "udp" || type !== "host" || !/^\d+\.\d+\.\d+\.\d+$/u.test(ip!)) continue;
    const proxied = await bridge.proxyFor(role, ip!, Number(port));
    out.push(`a=candidate:${foundation} ${component} udp ${priority} 127.0.0.1 ${proxied} typ host${rest}`);
  }
  return out.join("\r\n");
}

/** A peer whose descriptions pass through the shim on the way out (Drop's) and in (the page's). */
function shimmed(inner: PeerLike): PeerLike {
  return {
    get channel() { return inner.channel; },
    get state() { return inner.state; },
    offer: async (restart) => throughShim(await inner.offer(restart), "drop"),
    answer: (sdp) => inner.answer(sdp),
    applyAnswer: async (sdp) => inner.applyAnswer(await throughShim(sdp, "phone")),
    onState: (listener) => inner.onState(listener),
    close: () => inner.close(),
  };
}

// ------------------------------------------------------------------- driving

async function start(next: HarnessConfig): Promise<void> {
  config = next;
  await init();
  const relay = createLiveRelayClient({ apiUrl: next.relayApi, allowLoopbackHttp: true });
  flow = createPairingFlow({
    session: next.session,
    secretWords: next.secretWords,
    role: "inviter",
    namespace: next.namespace,
    purpose: next.purpose,
    now: () => Math.floor(Date.now() / 1000),
    transport: relay.inviter({ allocation: next.allocation }),
  });
  phase("pairing");
  flow.pair().then((words) => {
    status.checkWords = words;
    text("words", words);
    phase("check");
  }, (error: unknown) => {
    status.failure = error instanceof Error ? error.message : String(error);
    phase("pair-failed");
  });
}

async function confirm(matches: boolean): Promise<void> {
  if (!flow || !config) throw new Error("not started");
  const active = flow;
  const settings = config;
  active.verify({ matches });
  if (!matches) {
    phase("mismatch");
    return;
  }
  const createPeer: PeerFactory = (options) => {
    const real = new DirectPeer(options);
    return settings.shim ? shimmed(real) : real;
  };
  receiver = new ReceiverSession({
    exchange: fromPairingExchange(active.exchange()),
    createPeer,
    ...(settings.gatherMs === undefined ? {} : { gatherMs: settings.gatherMs }),
    ...(settings.restartAfterMs === undefined ? {} : { restartAfterMs: settings.restartAfterMs }),
    ...(settings.giveUpMs === undefined ? {} : { giveUpMs: settings.giveUpMs }),
  });
  await receiver.invitation({ dir: "to-drop", hide: settings.hide, ice: settings.inviteIce, id: settings.id, max: settings.max });
  phase("invited");
  receiver.readManifest().then((manifest) => {
    status.manifest = { name: manifest.name, size: manifest.size, type: manifest.type };
    text("manifest", `${manifest.name} ${manifest.size}`);
    phase("manifest");
  }, (error: unknown) => end(error));
}

function end(error: unknown): void {
  status.failure = error instanceof DirectError ? error.kind : String(error);
  phase("ended");
}

async function accept(): Promise<void> {
  if (!receiver || !config) throw new Error("no manifest to accept");
  const settings = config;
  phase("connecting");
  const sinkHolder: { file?: () => File | undefined } = {};
  receiver.accept({
    iceServers: settings.dropIce,
    hide: settings.hide,
    createSink: (transfer) => {
      const sink = createMemorySink({ key: transfer.key, manifest: transfer.manifest, envelopeBytes: transfer.envelopeBytes });
      sinkHolder.file = () => sink.file;
      status.total = transfer.envelopeBytes;
      return sink;
    },
    onConnected: () => phase("receiving"),
    onProgress: (written, total) => {
      status.written = written;
      status.total = total;
      (document.getElementById("progress") as HTMLProgressElement).max = total;
      (document.getElementById("progress") as HTMLProgressElement).value = written;
    },
    onReconnecting: (on) => {
      status.reconnecting = on;
      note(on ? "reconnecting" : "reconnected");
    },
  }).then(async () => {
    const file = sinkHolder.file?.();
    if (!file) {
      status.failure = "kept without a file";
      phase("ended");
      return;
    }
    status.kept = { name: file.name, size: file.size, type: file.type, sha256: await sha256Hex(file) };
    saveUrl = URL.createObjectURL(file);
    const link = document.getElementById("save") as HTMLAnchorElement;
    link.href = saveUrl;
    link.download = file.name;
    link.hidden = false;
    phase("kept");
  }, (error: unknown) => end(error));
}

async function decline(): Promise<void> {
  if (!receiver) throw new Error("no manifest to decline");
  await receiver.decline();
  phase("declined");
}

window.__drop = {
  start,
  confirm,
  accept,
  decline,
  restartIce: () => receiver?.restartIce(),
  stop: (reason?: "cancelled" | "failed") => receiver?.stop(reason),
  snapshot: () => ({ ...status, events: [...status.events], restarts: receiver?.restarts ?? 0, saveVisible: !(document.getElementById("save") as HTMLElement).hidden }),
};
