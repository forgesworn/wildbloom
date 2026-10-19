import { getPublicKey } from "nostr-tools/pure";
import { parseInputKey } from "../core/crypto.js";
import { MAX_PROTOTYPE_TRANSFER_BYTES } from "../core/security.js";
import { flatMembers, hasExactMembers, jsonString, jsonU64, member } from "./strict-json.js";

/**
 * The `wildbloom-request/1` invitation (wildbloom-node docs/PROTOCOL.md, "File
 * requests"). It is the transfer-v1 invitation bytes Drop sends after the check
 * words, and it holds two secrets: the key the page signs its upload with and
 * the key the file is encrypted under. Nothing here logs or stores either.
 *
 * This parser matches `check_invitation` in wildbloomd's
 * `grants/tests/requests.rs` rule for rule and in the same order, and must pass
 * every case in the shared `wildbloom-request-v1.json` vectors.
 */

export type InvitationFailure =
  | "length" | "shape" | "version" | "node" | "signer" | "key" | "size" | "bytes" | "files" | "until" | "canonical";

export class RequestInvitationError extends Error {
  constructor(readonly reason: InvitationFailure) {
    super(`The request details were refused: ${reason}.`);
    this.name = "RequestInvitationError";
  }
}

export const INVITATION_VERSION = "wildbloom-request/1";
/** The transfer-v1 invitation limit. */
export const INVITATION_MAX_BYTES = 16_364;
/** One envelope with the smallest padding bucket: 56-byte header, 64 KiB record and its tag. */
export const MIN_ENVELOPE_BYTES = 56 + 64 * 1024 + 16;
export const MAX_ENVELOPE_BYTES = MAX_PROTOTYPE_TRANSFER_BYTES;
export const MAX_PLAINTEXT_BYTES = 250_000_000;
export const MAX_GRANT_SECONDS = 86_400;

const KEYS = ["v", "node", "signer", "key", "size", "bytes", "files", "until"] as const;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const HEX_SECRET = /^[0-9a-f]{64}$/u;

export interface RequestInvitation {
  /** The node's origin exactly as sent, with its trailing slash. */
  readonly node: string;
  /** `node` without the trailing slash, as fetch and XMLHttpRequest take it. */
  readonly origin: string;
  /** The BUD-11 `server` tag: the node's host without a port. */
  readonly serverTag: string;
  /** The request public key the node will list the upload under. */
  readonly pubkey: string;
  /** The file key, `wbk1_` form. The page encrypts with it instead of making one. */
  readonly key: string;
  /** The largest envelope the page may upload. */
  readonly size: number;
  /** The largest plaintext. */
  readonly bytes: number;
  readonly files: 1;
  /** When the grant ends, in Unix seconds. */
  readonly until: number;
  /** The request secret key. Zeroed by `dispose()`. */
  readonly signer: Uint8Array;
  /** Zeroes the secret key bytes. The file key string cannot be erased from memory. */
  dispose(): void;
}

function refuse(reason: InvitationFailure): never {
  throw new RequestInvitationError(reason);
}

/** The serialised-origin rule from the protocol, as `check_node` applies it. Returns the host, or undefined. */
function checkNode(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  const host = url.hostname;
  const loopback = LOOPBACK_HOSTS.has(host);
  const onion = host.replace(/\.+$/u, "").endsWith(".onion");
  const scheme = url.protocol === "https:" || (url.protocol === "http:" && loopback);
  // An empty query or fragment serialises to "?" or "#" but reads back as empty, so look at the text.
  const clean = url.username === "" && url.password === "" && url.pathname === "/" && !text.includes("?") && !text.includes("#");
  return url.href === text && scheme && !onion && clean && host !== "" ? host : undefined;
}

function stringValue(raw: string | undefined): string {
  const value = jsonString(raw);
  return value === undefined ? refuse("shape") : value;
}

function integerValue(raw: string | undefined): bigint {
  const value = jsonU64(raw);
  return value === undefined ? refuse("shape") : value;
}

/**
 * Strict validation of untrusted invitation bytes. Never fetches anything.
 * Throws `RequestInvitationError` naming the rule that was broken.
 */
export function parseRequestInvitation(payload: Uint8Array, nowSeconds: number): RequestInvitation {
  if (payload.byteLength === 0 || payload.byteLength > INVITATION_MAX_BYTES) refuse("length");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    return refuse("shape");
  }
  const members = flatMembers(text);
  if (members === undefined) return refuse("shape");
  if (!hasExactMembers(members, KEYS)) refuse("shape");
  const raw = (name: string): string | undefined => member(members, name);
  const version = stringValue(raw("v"));
  const node = stringValue(raw("node"));
  const signerHex = stringValue(raw("signer"));
  const key = stringValue(raw("key"));
  const size = integerValue(raw("size"));
  const bytes = integerValue(raw("bytes"));
  const files = integerValue(raw("files"));
  const until = integerValue(raw("until"));

  if (version !== INVITATION_VERSION) refuse("version");
  const serverTag = checkNode(node);
  if (serverTag === undefined) refuse("node");
  if (!HEX_SECRET.test(signerHex)) refuse("signer");
  const signer = Uint8Array.from(signerHex.match(/../gu)!, (pair) => Number.parseInt(pair, 16));
  const dispose = (): void => { signer.fill(0); };
  let pubkey: string;
  try {
    pubkey = getPublicKey(signer);
  } catch {
    dispose();
    return refuse("signer");
  }
  try {
    parseInputKey(key).fill(0);
  } catch {
    dispose();
    refuse("key");
  }
  const now = BigInt(nowSeconds);
  const rule: InvitationFailure | undefined
    = size < BigInt(MIN_ENVELOPE_BYTES) || size > BigInt(MAX_ENVELOPE_BYTES) ? "size"
      : bytes === 0n || bytes >= size || bytes > BigInt(MAX_PLAINTEXT_BYTES) ? "bytes"
        : files !== 1n ? "files"
          : until <= now || until > now + BigInt(MAX_GRANT_SECONDS) || until > BigInt(Number.MAX_SAFE_INTEGER) ? "until"
            : JSON.stringify({ v: version, node, signer: signerHex, key, size: Number(size), bytes: Number(bytes), files: 1, until: Number(until) }) !== text
              ? "canonical" : undefined;
  if (rule) {
    dispose();
    refuse(rule);
  }
  return Object.freeze({
    node,
    origin: node.replace(/\/$/u, ""),
    serverTag: serverTag!,
    pubkey,
    key,
    size: Number(size),
    bytes: Number(bytes),
    files: 1 as const,
    until: Number(until),
    signer,
    dispose,
  });
}
