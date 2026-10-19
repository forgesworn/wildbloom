/**
 * The one message the recipient page sends back to the sender: the file has
 * been handed to the browser to save. The channel that carried the share
 * details is kept open for it (foregather-transfer-reply/1, at most 1,024
 * bytes, before the session deadline). The bytes never vary and say nothing
 * about the file.
 */
export const DOWNLOADED_REPLY = '{"v":1,"event":"downloaded"}';

/** The part of the pairing flow this page uses once the share details are in. */
export interface ReplyChannel {
  reply(input: { readonly payload: Uint8Array }): Promise<void>;
  dispose(): void;
}

export interface DownloadedReply {
  /**
   * Best effort and at most once. Resolves when the attempt has settled, and
   * never rejects: an expired session or a network failure is not the
   * recipient's problem, and the same bytes are never sent twice.
   */
  send(): Promise<void>;
  /** Closes the kept channel, whether or not the reply went out. Safe to repeat. */
  dispose(): void;
}

export function createDownloadedReply(channel: ReplyChannel): DownloadedReply {
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
    async send(): Promise<void> {
      if (started || closed) return;
      started = true;
      try {
        await channel.reply({ payload: new TextEncoder().encode(DOWNLOADED_REPLY) });
      } catch {
        // Expired, offline or refused: nothing to show and nothing to retry.
      } finally {
        close();
      }
    },
    dispose: close,
  };
}
