import { flatMembers, hasExactMembers, jsonString, jsonU64, member } from "./strict-json.js";

/**
 * The one early message the page may send back to Drop: the file is locked and
 * on its way. It goes inside foregather-transfer-reply/1 (at most 1,024 bytes,
 * before the session deadline) on the channel kept open after the invitation.
 *
 * It carries only the envelope's hash and size, never the name or type, which
 * would not reliably fit. Drop finds the upload by listing the request key's
 * claims, so a reply that never arrives changes nothing: this is early
 * feedback only.
 */

const HEX_64 = /^[0-9a-f]{64}$/u;

export interface SendingReply {
  readonly sha256: string;
  readonly size: number;
}

/** The canonical reply bytes. Refuses anything the strict reader below would not read back. */
export function sendingReplyBytes(sha256: string, size: number): Uint8Array {
  if (!HEX_64.test(sha256) || !Number.isSafeInteger(size) || size < 1) throw new Error("The upload details are not in the form the reply allows.");
  return new TextEncoder().encode(JSON.stringify({ v: 1, event: "sending", sha256, size }));
}

/**
 * Reads a reply as Drop does: exactly these four members, in any order and with
 * any JSON whitespace, no repeats, `v` the whole number 1, `event` exactly
 * `sending`, a lower-case 64-digit hash and a size from 1 to 2^53 - 1.
 * Anything else is no reply.
 */
export function parseSendingReply(bytes: Uint8Array): SendingReply | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const members = flatMembers(text);
  if (members === undefined || !hasExactMembers(members, ["v", "event", "sha256", "size"])) return undefined;
  const version = jsonU64(member(members, "v"));
  const event = jsonString(member(members, "event"));
  const sha256 = jsonString(member(members, "sha256"));
  const size = jsonU64(member(members, "size"));
  if (version !== 1n || event !== "sending" || sha256 === undefined || !HEX_64.test(sha256)) return undefined;
  if (size === undefined || size < 1n || size > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return { sha256, size: Number(size) };
}

/** The part of the pairing flow this page uses once the invitation is in. */
export interface ReplyChannel {
  reply(input: { readonly payload: Uint8Array }): Promise<void>;
  dispose(): void;
}

export interface EarlyReply {
  /**
   * Best effort and at most once. Resolves when the attempt has settled and
   * never rejects: an expired session or a network failure is not the sender's
   * problem, and the upload does not wait for it.
   */
  send(sha256: string, size: number): Promise<void>;
  /** Closes the kept channel, whether or not the reply went out. Safe to repeat. */
  dispose(): void;
}

export function createEarlyReply(channel: ReplyChannel): EarlyReply {
  let started = false;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      channel.dispose();
    } catch {
      // Closing a channel that is already gone is not worth reporting.
    }
  };
  return {
    async send(sha256: string, size: number): Promise<void> {
      if (started || closed) return;
      started = true;
      try {
        await channel.reply({ payload: sendingReplyBytes(sha256, size) });
      } catch {
        // Expired, offline or refused: nothing to show and nothing to retry.
      } finally {
        close();
      }
    },
    dispose: close,
  };
}
