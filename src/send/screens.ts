import { COPY, formatBytes } from "./copy.js";
import type { ViewState } from "./state.js";

/**
 * The heading and lede of the screen the state is on. Headings that name the file are written from the state.
 * Once the end of the file has been sent, each ending that would say "nothing was kept" says the outcome is not
 * known instead, because the receiver may already be keeping the file.
 */
export function screenText(state: ViewState): { h1: string; body?: string } {
  const copy = COPY.screens;
  const limit = formatBytes(state.maxBytes);
  const late = state.endSent;
  switch (state.screen) {
    case "unsupported": return copy.unsupported;
    case "incomplete": return copy.incomplete;
    case "expired": return copy.expired;
    case "words": return copy.words;
    case "connecting": return copy.connecting;
    case "waiting": return copy.waiting;
    case "wrong-words": return copy.wrongWords;
    case "used": return copy.used;
    case "network": return copy.network;
    case "check": return copy.check;
    case "mismatch": return copy.mismatch;
    case "confirming": return copy.confirming;
    case "choose": return { h1: copy.choose.h1, body: copy.choose.body(limit) };
    case "asking": return { h1: copy.asking.h1, body: copy.asking.body(state.fileName) };
    case "declined": return copy.declined;
    case "linking": return copy.linking;
    case "sending": return { h1: copy.sending.h1(state.fileName), body: copy.sending.body };
    case "finishing": return copy.finishing;
    case "sent": return { h1: copy.sent.h1, body: copy.sent.body(state.fileName) };
    case "too-big": return { h1: copy.tooBig.h1, body: copy.tooBig.body(limit) };
    case "empty": return copy.empty;
    case "unreadable": return copy.unreadable;
    case "no-relay": return copy.cannotHide;
    case "no-room": return late ? copy.afterEnd.noRoom : copy.noRoom;
    case "connect-failed": return copy.connectFailed;
    case "connect-failed-direct": return copy.connectFailedDirect;
    case "lost": return late ? copy.afterEnd.lost : copy.lost;
    case "they-stopped": return late ? copy.afterEnd.theyStopped : copy.theyStopped;
    case "failed": return late ? copy.afterEnd.failed : copy.failed;
    case "cancelled": return late ? copy.afterEnd.cancelled : copy.cancelled;
    case "invalid": return copy.invalid;
  }
}
