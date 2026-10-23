import type { LinkProblem } from "../get/link.js";

/** One identifier per screen of the sender page. */
export type ScreenId =
  | "unsupported" | "incomplete" | "expired" | "words" | "connecting" | "waiting" | "wrong-words" | "used" | "network"
  | "check" | "mismatch" | "confirming"
  | "choose" | "too-big" | "empty" | "unreadable"
  | "asking" | "declined" | "linking" | "sending" | "finishing" | "sent"
  | "no-relay" | "no-room" | "connect-failed" | "connect-failed-direct" | "lost" | "they-stopped" | "failed"
  | "cancelled" | "invalid";

export interface ViewState {
  readonly screen: ScreenId;
  readonly offline: boolean;
  /** Three check words while the sender compares them with the person at the computer. */
  readonly checkWords: string;
  readonly fileName: string;
  /** The chosen file's size in bytes. */
  readonly fileSize: number;
  /** The most the receiver will take, shown on the choose and too-big screens. */
  readonly maxBytes: number;
  /** Bytes the receiver has acknowledged, and the envelope length. */
  readonly sent: number;
  readonly total: number;
  /** The connection dropped and the page is waiting for it to come back. */
  readonly reconnecting: boolean;
  /** Whether this phone hides its own address. */
  readonly hide: boolean;
  /** Whether the receiver hides its address from this phone. */
  readonly theirHidden: boolean;
  /** Whether the invitation holds a TURN URL, which hiding this phone's address needs. */
  readonly relayOffered: boolean;
  /**
   * The end of the file has been sent, so the receiver may already be keeping it. From then on the only ending
   * that says it arrived is the receiver's own "kept"; every other ending must say the outcome is not known.
   */
  readonly endSent: boolean;
}

export type ViewEvent =
  | { readonly type: "start"; readonly link: LinkProblem | "ok" }
  | { readonly type: "unsupported" }
  | { readonly type: "online"; readonly online: boolean }
  | { readonly type: "continue" }
  | { readonly type: "slow" }
  | { readonly type: "claim-refused" }
  | { readonly type: "network" }
  | { readonly type: "wrong-words" }
  | { readonly type: "paired"; readonly words: string }
  | { readonly type: "yes" }
  | { readonly type: "no" }
  | { readonly type: "invitation"; readonly maxBytes: number; readonly theirHidden: boolean; readonly relayOffered: boolean }
  | { readonly type: "invalid-invitation" }
  | { readonly type: "expired" }
  | { readonly type: "hide"; readonly on: boolean }
  | { readonly type: "too-big" }
  | { readonly type: "empty" }
  | { readonly type: "unreadable" }
  | { readonly type: "asking"; readonly name: string; readonly size: number }
  | { readonly type: "declined" }
  | { readonly type: "linking" }
  | { readonly type: "sending"; readonly total: number }
  | { readonly type: "end-sent" }
  | { readonly type: "progress"; readonly sent: number }
  | { readonly type: "reconnecting"; readonly on: boolean }
  | { readonly type: "sent" }
  | { readonly type: "no-relay" }
  | { readonly type: "no-room" }
  | { readonly type: "connect-failed" }
  | { readonly type: "lost" }
  | { readonly type: "they-stopped" }
  | { readonly type: "failed" }
  | { readonly type: "back" }
  | { readonly type: "cancel" };

export const INITIAL_STATE: ViewState = Object.freeze({
  screen: "words",
  offline: false,
  checkWords: "",
  fileName: "",
  fileSize: 0,
  maxBytes: 0,
  sent: 0,
  total: 0,
  reconnecting: false,
  hide: false,
  theirHidden: false,
  relayOffered: false,
  endSent: false,
});

const PAIRING: readonly ScreenId[] = ["connecting", "waiting"];
/** Screens before the people have chosen a file, where the 10-minute link can still run out. */
const BEFORE_FILE: readonly ScreenId[] = ["words", "connecting", "waiting", "network", "check", "confirming", "choose", "too-big", "empty", "unreadable"];
/** Screens where a file can be picked. */
const PICKING: readonly ScreenId[] = ["choose", "too-big", "empty", "unreadable"];
/** Screens after the file was offered, where the session can still end under the sender. */
const AFTER_OFFER: readonly ScreenId[] = ["asking", "linking", "sending", "finishing"];

function go(state: ViewState, screen: ScreenId, extra: Partial<ViewState> = {}): ViewState {
  return { ...state, ...extra, screen };
}

/** Pure transitions. An event that does not apply to the current screen changes nothing. */
export function reduce(state: ViewState, event: ViewEvent): ViewState {
  const at = state.screen;
  switch (event.type) {
    case "start":
      if (at !== "words" || event.link === "ok") return state;
      return go(state, event.link === "expired" ? "expired" : "incomplete");
    case "unsupported":
      return go(state, "unsupported");
    case "online":
      return state.offline === !event.online ? state : { ...state, offline: !event.online };
    case "continue":
      return at === "words" || at === "network" ? go(state, "connecting") : state;
    case "slow":
      return at === "connecting" ? go(state, "waiting") : state;
    case "claim-refused":
      return PAIRING.includes(at) ? go(state, "used") : state;
    case "network":
      return PAIRING.includes(at) ? go(state, "network") : state;
    case "wrong-words":
      return PAIRING.includes(at) ? go(state, "wrong-words") : state;
    case "paired":
      return PAIRING.includes(at) ? go(state, "check", { checkWords: event.words }) : state;
    case "yes":
      return at === "check" ? go(state, "confirming") : state;
    case "no":
      return at === "check" ? go(state, "mismatch", { checkWords: "" }) : state;
    case "invitation":
      return at === "confirming" ? go(state, "choose", { maxBytes: event.maxBytes, theirHidden: event.theirHidden, relayOffered: event.relayOffered, hide: event.relayOffered && state.hide, checkWords: "" }) : state;
    case "invalid-invitation":
      return at === "confirming" ? go(state, "invalid", { checkWords: "" }) : state;
    case "expired":
      return BEFORE_FILE.includes(at) || at === "asking" ? go(state, "expired", { checkWords: "" }) : state;
    case "hide":
      // Hiding needs a TURN URL in the invitation; without one the choice is not offered and cannot be turned on.
      return state.hide === (event.on && state.relayOffered) ? state : { ...state, hide: event.on && state.relayOffered };
    case "too-big":
      return PICKING.includes(at) ? go(state, "too-big") : state;
    case "empty":
      return PICKING.includes(at) ? go(state, "empty") : state;
    case "unreadable":
      return PICKING.includes(at) ? go(state, "unreadable") : state;
    case "asking":
      return PICKING.includes(at) ? go(state, "asking", { fileName: event.name, fileSize: event.size, sent: 0, total: 0, reconnecting: false, endSent: false }) : state;
    case "declined":
      return at === "asking" ? go(state, "declined") : state;
    case "linking":
      return at === "asking" ? go(state, "linking") : state;
    case "sending":
      return at === "asking" || at === "linking" ? go(state, "sending", { total: event.total, sent: 0, reconnecting: false }) : state;
    case "progress":
      return at === "sending" ? { ...state, sent: event.sent } : state;
    case "end-sent":
      // The last byte and the end marker have gone: waiting for the receiver to say it has kept the file.
      return at === "sending" ? go(state, "finishing", { endSent: true }) : state;
    case "reconnecting":
      return (at === "sending" || at === "linking" || at === "finishing") && state.reconnecting !== event.on ? { ...state, reconnecting: event.on } : state;
    case "sent":
      return at === "sending" || at === "linking" || at === "finishing" ? go(state, "sent", { reconnecting: false }) : state;
    case "no-relay":
      return AFTER_OFFER.includes(at) ? go(state, "no-relay", { reconnecting: false }) : state;
    case "no-room":
      return AFTER_OFFER.includes(at) ? go(state, "no-room", { reconnecting: false }) : state;
    case "connect-failed":
      // With no relay on offer the two ends can only meet directly, and some networks do not allow that.
      return AFTER_OFFER.includes(at) ? go(state, state.relayOffered ? "connect-failed" : "connect-failed-direct", { reconnecting: false }) : state;
    case "lost":
      return AFTER_OFFER.includes(at) || at === "choose" || at === "confirming" ? go(state, "lost", { reconnecting: false, checkWords: "" }) : state;
    case "they-stopped":
      return AFTER_OFFER.includes(at) || at === "choose" || at === "confirming" ? go(state, "they-stopped", { reconnecting: false, checkWords: "" }) : state;
    case "failed":
      return AFTER_OFFER.includes(at) || at === "choose" || at === "confirming" ? go(state, "failed", { reconnecting: false, checkWords: "" }) : state;
    case "back":
      return at === "connecting" ? go(state, "words") : state;
    case "cancel":
      return PAIRING.includes(at) || at === "confirming" || PICKING.includes(at) || AFTER_OFFER.includes(at) ? go(state, "cancelled", { checkWords: "", reconnecting: false }) : state;
    default:
      return state;
  }
}
