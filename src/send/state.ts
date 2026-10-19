import type { LinkProblem } from "../get/link.js";

/** One identifier per screen of the sender page. */
export type ScreenId =
  | "unsupported" | "incomplete" | "expired" | "words" | "connecting" | "waiting" | "wrong-words" | "used" | "network"
  | "check" | "mismatch" | "confirming"
  | "choose" | "preparing" | "sending" | "sent" | "too-big" | "empty" | "unreadable" | "no-room" | "stopped" | "ended"
  | "cancelled" | "invalid";

export interface ViewState {
  readonly screen: ScreenId;
  readonly offline: boolean;
  /** Three check words while the sender compares them with the person who asked. */
  readonly checkWords: string;
  readonly fileName: string;
  /** The most plaintext the request allows, shown on the choose and too-big screens. */
  readonly maxBytes: number;
  /** Bytes of the locked file sent so far, and its total. */
  readonly sent: number;
  readonly total: number;
  /** The last attempt failed and the page is waiting to repeat it by itself. */
  readonly retrying: boolean;
  /** The node refused the signed event, which points at the phone's clock. */
  readonly clockHint: boolean;
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
  | { readonly type: "invitation"; readonly maxBytes: number }
  | { readonly type: "invalid-invitation" }
  | { readonly type: "expired" }
  | { readonly type: "ended" }
  | { readonly type: "too-big" }
  | { readonly type: "empty" }
  | { readonly type: "unreadable" }
  | { readonly type: "preparing"; readonly name: string }
  | { readonly type: "sending"; readonly total: number }
  | { readonly type: "progress"; readonly sent: number }
  | { readonly type: "retrying"; readonly on: boolean }
  | { readonly type: "sent" }
  | { readonly type: "stopped"; readonly clockHint?: boolean }
  | { readonly type: "no-room" }
  | { readonly type: "again" }
  | { readonly type: "back" }
  | { readonly type: "cancel" };

export const INITIAL_STATE: ViewState = Object.freeze({
  screen: "words",
  offline: false,
  checkWords: "",
  fileName: "",
  maxBytes: 0,
  sent: 0,
  total: 0,
  retrying: false,
  clockHint: false,
});

const PAIRING: readonly ScreenId[] = ["connecting", "waiting"];
/** Screens before the invitation arrives, where the 10-minute link can still run out. */
const BEFORE_INVITATION: readonly ScreenId[] = ["words", "connecting", "waiting", "network", "check", "confirming"];
/** Screens where the person can pick a file, so a refusal can send them back to choose another. */
const PICKING: readonly ScreenId[] = ["choose", "too-big", "empty", "unreadable", "no-room"];
/** Screens where the request can still end under the sender. */
const OPEN: readonly ScreenId[] = ["confirming", "choose", "preparing", "stopped", "too-big", "empty", "unreadable", "no-room"];

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
      return PAIRING.includes(at) || at === "check" || at === "confirming" ? go(state, "network") : state;
    case "wrong-words":
      return PAIRING.includes(at) ? go(state, "wrong-words") : state;
    case "paired":
      return PAIRING.includes(at) ? go(state, "check", { checkWords: event.words }) : state;
    case "yes":
      return at === "check" ? go(state, "confirming") : state;
    case "no":
      return at === "check" ? go(state, "mismatch", { checkWords: "" }) : state;
    case "invitation":
      return at === "confirming" ? go(state, "choose", { maxBytes: event.maxBytes, checkWords: "" }) : state;
    case "invalid-invitation":
      return at === "confirming" ? go(state, "invalid", { checkWords: "" }) : state;
    case "expired":
      return BEFORE_INVITATION.includes(at) ? go(state, "expired", { checkWords: "" }) : state;
    case "ended":
      return OPEN.includes(at) || at === "sending" ? go(state, "ended", { checkWords: "", retrying: false }) : state;
    case "too-big":
      return PICKING.includes(at) ? go(state, "too-big") : state;
    case "empty":
      return PICKING.includes(at) ? go(state, "empty") : state;
    case "unreadable":
      return at === "preparing" || PICKING.includes(at) ? go(state, "unreadable") : state;
    case "preparing":
      return PICKING.includes(at) ? go(state, "preparing", { fileName: event.name, sent: 0, total: 0, retrying: false, clockHint: false }) : state;
    case "sending":
      return at === "preparing" || at === "stopped" ? go(state, "sending", { total: event.total, sent: 0, retrying: false, clockHint: false }) : state;
    case "progress":
      return at === "sending" ? { ...state, sent: event.sent, retrying: false } : state;
    case "retrying":
      // A repeat starts from the beginning, so the count does too.
      return at === "sending" && state.retrying !== event.on ? { ...state, retrying: event.on, ...(event.on ? { sent: 0 } : {}) } : state;
    case "sent":
      return at === "sending" ? go(state, "sent", { retrying: false }) : state;
    case "stopped":
      return at === "sending" ? go(state, "stopped", { retrying: false, clockHint: event.clockHint === true }) : state;
    case "no-room":
      return at === "sending" ? go(state, "no-room", { retrying: false }) : state;
    case "again":
      return PICKING.includes(at) ? go(state, "choose") : state;
    case "back":
      return at === "connecting" ? go(state, "words") : state;
    case "cancel":
      return PAIRING.includes(at) || at === "confirming" ? go(state, "cancelled", { checkWords: "" }) : state;
    default:
      return state;
  }
}
