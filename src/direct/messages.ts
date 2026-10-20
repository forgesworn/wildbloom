import { sanitiseFileName } from "../core/security.js";
import { LIMITS } from "./config.js";

/**
 * The wildbloom-direct/1 messages carried over the foregather-exchange/1
 * channel (docs/PROTOCOL.md "Direct send" in wildbloom-node). Every message is
 * one strict canonical JSON object, so a reader parses it, checks it,
 * serialises it again and compares the bytes.
 */

export type Side = "drop" | "page";

/** What a `stop` message and the reader's refusals say. */
export type StopReason = "cancelled" | "unsupported" | "failed";

export interface IceServer {
  readonly credential: string;
  readonly urls: readonly string[];
  readonly username: string;
}

export interface Invite {
  readonly event: "invite";
  readonly dir: "to-drop";
  readonly hide: boolean;
  readonly ice: readonly IceServer[];
  readonly id: string;
  readonly max: number;
}
export interface Manifest {
  readonly event: "manifest";
  readonly name: string;
  readonly size: number;
  readonly type: string;
}
export interface Accept { readonly event: "accept"; readonly sdp: string }
export interface Decline { readonly event: "decline" }
export interface Answer { readonly event: "answer"; readonly key: string; readonly sdp: string }
export interface Restart { readonly event: "restart"; readonly sdp: string }
export interface RestartAnswer { readonly event: "restart-answer"; readonly sdp: string }
export interface Stop { readonly event: "stop"; readonly reason: StopReason }

export type DirectMessage = Invite | Manifest | Accept | Decline | Answer | Restart | RestartAnswer | Stop;

export type DecodeResult =
  | { readonly ok: true; readonly message: DirectMessage }
  /** `stop` is the reason the reader sends, and `detail` is for logs and tests, never for a person. */
  | { readonly ok: false; readonly stop: "failed" | "unsupported"; readonly detail: string };

export interface DecodeContext {
  /** Who sent it. */
  readonly from: Side;
  /** The sender's exchange message index, 0 to 7. */
  readonly index: number;
  /** The page's build-time ICE allowlist, for `invite`. */
  readonly iceAllowlist: readonly string[];
  /** The `max` Drop offered, for `manifest`. */
  readonly max?: number;
}

// ------------------------------------------------------------ canonical text

const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * Serialises a value in the protocol's canonical form: no whitespace, members in
 * ascending order of their names at every depth, strings as `JSON.stringify`
 * writes them, integers from 0 to 2^53 - 1, booleans, arrays, and no null.
 * Anything else, including a lone surrogate, throws.
 */
export function canonicalJson(value: unknown): string {
  switch (typeof value) {
    case "string":
      if (LONE_SURROGATE.test(value)) throw new TypeError("Lone surrogate in a string.");
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw new TypeError("Not a canonical integer.");
      return String(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (value === null) throw new TypeError("null is not allowed.");
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => `${canonicalJson(key)}:${canonicalJson(record[key])}`).join(",")}}`;
    }
    default:
      throw new TypeError("Not a JSON value.");
  }
}

/** The bytes a sender puts on the exchange. Refuses anything over the message limit. */
export function encodeMessage(message: DirectMessage): Uint8Array {
  const bytes = new TextEncoder().encode(canonicalJson({ ...message, v: 1 }));
  if (bytes.length > LIMITS.messageBytes) throw new RangeError("The message is larger than the exchange allows.");
  return bytes;
}

// ------------------------------------------------------------------ checking

type Bad = { readonly bad: "failed" | "unsupported"; readonly detail: string };
const failed = (detail: string): Bad => ({ bad: "failed", detail });
const unsupported = (detail: string): Bad => ({ bad: "unsupported", detail });
const isBad = (value: unknown): value is Bad => typeof value === "object" && value !== null && "bad" in value;

type Plain = Record<string, unknown>;
const isPlain = (value: unknown): value is Plain => typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactly = (value: Plain, names: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === names.length && names.every((name) => Object.hasOwn(value, name));
};

const CONTROL = /[\u0000-\u001f\u007f]/u;
const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The shape of a session description the page and Drop accept: printable ASCII
 * with CRLF line ends, one data-channel media section, and a SHA-256
 * fingerprint. Offers and answers reach each side only through the AEAD channel
 * whose words the people compared, so the fingerprint is bound to the peer.
 */
export function checkSdp(sdp: string): string | undefined {
  if (sdp.length === 0 || utf8Length(sdp) > LIMITS.sdpBytes) return "The description is empty or over 8,000 bytes.";
  if (!/^[\r\n\x20-\x7e]*$/u.test(sdp)) return "The description is not printable ASCII.";
  if (!sdp.startsWith("v=0\r\n") || !sdp.endsWith("\r\n")) return "The description does not start with v=0 or end in CRLF.";
  if (/(?:^|[^\r])\n|\r(?!\n)/u.test(sdp)) return "The description has a bare line feed or carriage return.";
  const lines = sdp.slice(0, -2).split("\r\n");
  const media = lines.filter((line) => line.startsWith("m="));
  if (media.length !== 1 || !/^m=application [0-9]+ UDP\/DTLS\/SCTP webrtc-datachannel$/u.test(media[0]!)) {
    return "The description must have exactly one data-channel media section.";
  }
  if (!lines.some((line) => line.startsWith("a=fingerprint:sha-256 "))) return "The description has no SHA-256 fingerprint.";
  return undefined;
}

const KEY = /^wbk1_[A-Za-z0-9_-]{43}$/u;
const ID = /^[A-Za-z0-9_-]{22}$/u;

/** 16 bytes in canonical unpadded base64url: the last character carries four padding bits, so only A, Q, g and w can end it. */
function isCanonicalId(value: string): boolean {
  return ID.test(value) && "AQgw".includes(value.charAt(21));
}

/** 32 bytes in canonical unpadded base64url: the last character carries two padding bits. */
function isCanonicalKey(value: string): boolean {
  return KEY.test(value) && "AEIMQUYcgkosw048".includes(value.charAt(value.length - 1));
}

function readIce(value: unknown, allowlist: readonly string[]): readonly IceServer[] | Bad {
  if (!Array.isArray(value) || value.length < 1 || value.length > LIMITS.iceServers) return failed("ice must hold 1 to 4 servers");
  const servers: IceServer[] = [];
  for (const entry of value as unknown[]) {
    if (!isPlain(entry) || !hasExactly(entry, ["credential", "urls", "username"])) return failed("an ice server has the wrong members");
    const { credential, urls, username } = entry;
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > LIMITS.urlsPerServer) return failed("urls must hold 1 to 4 URLs");
    for (const url of urls as unknown[]) {
      if (typeof url !== "string" || !/^(?:stun|turn|turns):[^\s]+$/u.test(url) || utf8Length(url) > LIMITS.urlBytes) return failed("an ice URL is malformed");
    }
    for (const secret of [username, credential]) {
      if (typeof secret !== "string" || secret.length === 0 || utf8Length(secret) > LIMITS.credentialBytes || CONTROL.test(secret)) {
        return failed("a username or credential is malformed");
      }
    }
    servers.push({ credential: credential as string, urls: urls as string[], username: username as string });
  }
  // Syntax first; only then the page's own policy, so a refusal for policy is always `unsupported`.
  for (const server of servers) {
    for (const url of server.urls) if (!allowlist.includes(url)) return unsupported("an ice URL is not on the build-time allowlist");
  }
  if (!servers.some((server) => server.urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:")))) {
    return unsupported("no TURN URL");
  }
  return servers;
}

function readInvite(body: Plain, context: DecodeContext): Invite | Bad {
  if (!hasExactly(body, ["dir", "event", "hide", "ice", "id", "max", "v"])) return failed("invite members");
  const { dir, hide, id, max } = body;
  if (typeof dir !== "string" || (dir !== "to-drop" && dir !== "from-drop")) return failed("unknown direction");
  if (typeof hide !== "boolean") return failed("hide must be a boolean");
  if (typeof id !== "string" || !isCanonicalId(id)) return failed("id is not 16 canonical base64url bytes");
  if (typeof max !== "number" || max < 1) return failed("max must be at least 1");
  const ice = readIce(body.ice, context.iceAllowlist);
  if (isBad(ice)) return ice;
  if (dir === "from-drop") return unsupported("this page sends; it does not receive");
  if (max > LIMITS.maxPlaintextBytes) return unsupported("max is above the 250,000,000 byte cap");
  return { event: "invite", dir: "to-drop", hide, ice, id, max };
}

/**
 * Characters that change how a name is drawn, or that cannot be seen at all, which the shared name rule lets
 * through: the bidirectional controls (so `invoice` + U+202E + `fdp.terminal` is drawn as `invoicelanimret.pdf`),
 * the zero-width and word-joining characters, and the byte order mark. A direct send's manifest refuses a name
 * that has any of them, and the sending page removes them from the name of a file it is asked to send.
 */
export const DISGUISING_CHARACTERS = /[\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;

function readManifest(body: Plain, context: DecodeContext): Manifest | Bad {
  if (!hasExactly(body, ["event", "name", "size", "type", "v"])) return failed("manifest members");
  const { name, size, type } = body;
  if (typeof name !== "string" || sanitiseFileName(name) !== name) return failed("name is not a fixed point of the name rule");
  if (name.search(DISGUISING_CHARACTERS) >= 0) return failed("name holds a character that disguises it");
  if (typeof type !== "string" || type.length < 1 || type.length > 255 || CONTROL.test(type) || type.toLowerCase() !== type) {
    return failed("type is not a lower-case media type");
  }
  if (typeof size !== "number") return failed("size must be an integer");
  if (context.max !== undefined && size > context.max) return unsupported("size is above max");
  return { event: "manifest", name, size, type };
}

function readSdpMessage(body: Plain, event: "accept" | "restart" | "restart-answer"): Accept | Restart | RestartAnswer | Bad {
  if (!hasExactly(body, ["event", "sdp", "v"])) return failed(`${event} members`);
  if (typeof body.sdp !== "string") return failed("sdp must be a string");
  const problem = checkSdp(body.sdp);
  if (problem) return failed(problem);
  return { event, sdp: body.sdp };
}

function readAnswer(body: Plain): Answer | Bad {
  if (!hasExactly(body, ["event", "key", "sdp", "v"])) return failed("answer members");
  if (typeof body.key !== "string" || !isCanonicalKey(body.key)) return failed("key is not a canonical wbk1_ key");
  if (typeof body.sdp !== "string") return failed("sdp must be a string");
  const problem = checkSdp(body.sdp);
  if (problem) return failed(problem);
  return { event: "answer", key: body.key, sdp: body.sdp };
}

function readStop(body: Plain): Stop | Bad {
  if (!hasExactly(body, ["event", "reason", "v"])) return failed("stop members");
  const { reason } = body;
  if (reason !== "cancelled" && reason !== "unsupported" && reason !== "failed") return failed("unknown stop reason");
  return { event: "stop", reason };
}

/** The events each side may send at each index. `stop` is allowed wherever a message is, except Drop's first. */
function allowedEvents(from: Side, index: number): readonly string[] {
  if (!Number.isInteger(index) || index < 0 || index >= LIMITS.messagesPerSide) return [];
  if (from === "drop") {
    if (index === 0) return ["invite"];
    if (index === 1) return ["accept", "decline", "stop"];
    if (index <= 1 + LIMITS.restarts) return ["restart", "stop"];
    return ["stop"];
  }
  if (index === 0) return ["manifest", "stop"];
  if (index === 1) return ["answer", "stop"];
  if (index <= 1 + LIMITS.restarts) return ["restart-answer", "stop"];
  return ["stop"];
}

/**
 * Reads one exchange message. A refusal carries the `stop` reason the reader
 * sends: `unsupported` for a version, direction, ICE server or size this end
 * cannot use, and `failed` for anything else that is not exactly the message.
 */
export function decodeMessage(bytes: Uint8Array, context: DecodeContext): DecodeResult {
  const refuse = (bad: Bad): DecodeResult => ({ ok: false, stop: bad.bad, detail: bad.detail });
  if (bytes.length > LIMITS.messageBytes) return refuse(failed("message over 16,379 bytes"));
  let text: string;
  try {
    // ignoreBOM keeps a byte order mark in the text, where it fails to parse.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refuse(failed("not UTF-8"));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse(failed("not JSON"));
  }
  if (!isPlain(parsed)) return refuse(failed("not an object"));
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    return refuse(failed("not canonical (value)"));
  }
  if (canonical !== text) return refuse(failed("not canonical (bytes)"));
  const version = parsed.v;
  if (typeof version !== "number") return refuse(failed("missing or malformed version"));
  if (version !== 1) return refuse(unsupported("version"));
  const event = parsed.event;
  if (typeof event !== "string" || !allowedEvents(context.from, context.index).includes(event)) {
    return refuse(failed("event not allowed here"));
  }
  let read: DirectMessage | Bad;
  switch (event) {
    case "invite": read = readInvite(parsed, context); break;
    case "manifest": read = readManifest(parsed, context); break;
    case "accept":
    case "restart":
    case "restart-answer": read = readSdpMessage(parsed, event); break;
    case "decline": read = hasExactly(parsed, ["event", "v"]) ? { event: "decline" } : failed("decline members"); break;
    case "answer": read = readAnswer(parsed); break;
    case "stop": read = readStop(parsed); break;
    default: read = failed("unknown event");
  }
  return isBad(read) ? refuse(read) : { ok: true, message: read };
}
