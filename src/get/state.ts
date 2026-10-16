import type { LinkProblem } from "./link.js";

/** One identifier per screen in design spec 6.5, plus two the spec left without copy. */
export type ScreenId =
  | "r2" | "r3" | "r4" | "r5" | "r6" | "r7" | "r8" | "r9" | "r10" | "r11" | "r12"
  | "r13" | "r14" | "r15" | "r16" | "r17" | "r18" | "r19" | "r20" | "r21" | "r22" | "r23"
  | "cancelled" | "invalid";

export interface ViewState {
  readonly screen: ScreenId;
  readonly offline: boolean;
  /** Three check words while the recipient compares them with the sender. */
  readonly checkWords: string;
  readonly fileName: string;
  readonly fileSize: number;
  readonly received: number;
  /** What Try again repeats. */
  readonly retry: "connect" | "download";
}

export type ViewEvent =
  | { readonly type: "start"; readonly link: LinkProblem | "ok" }
  | { readonly type: "unsupported" }
  | { readonly type: "continue" }
  | { readonly type: "slow" }
  | { readonly type: "claim-refused" }
  | { readonly type: "network" }
  | { readonly type: "wrong-words" }
  | { readonly type: "paired"; readonly words: string }
  | { readonly type: "yes" }
  | { readonly type: "no" }
  | { readonly type: "details"; readonly name: string; readonly size: number }
  | { readonly type: "invalid-details" }
  | { readonly type: "too-big" }
  | { readonly type: "expired" }
  | { readonly type: "download" }
  | { readonly type: "progress"; readonly received: number }
  | { readonly type: "checking" }
  | { readonly type: "saved" }
  | { readonly type: "save-failed" }
  | { readonly type: "save-again" }
  | { readonly type: "missing" }
  | { readonly type: "unavailable" }
  | { readonly type: "damaged" }
  | { readonly type: "back" }
  | { readonly type: "cancel" }
  | { readonly type: "online"; readonly online: boolean };

export const INITIAL_STATE: ViewState = Object.freeze({
  screen: "r5",
  offline: false,
  checkWords: "",
  fileName: "",
  fileSize: 0,
  received: 0,
  retry: "connect",
});

const PAIRING: readonly ScreenId[] = ["r6", "r7"];
const BEFORE_FILE: readonly ScreenId[] = ["r5", "r6", "r7", "r10", "r12", "r14"];

function go(state: ViewState, screen: ScreenId, extra: Partial<ViewState> = {}): ViewState {
  return { ...state, ...extra, screen };
}

/** Pure transitions. An event that does not apply to the current screen changes nothing. */
export function reduce(state: ViewState, event: ViewEvent): ViewState {
  const at = state.screen;
  switch (event.type) {
    case "start":
      if (at !== "r5") return state;
      if (event.link === "ok") return state;
      return go(state, event.link === "expired" ? "r4" : "r3");
    case "unsupported":
      return go(state, "r2");
    case "online":
      return state.offline === !event.online ? state : { ...state, offline: !event.online };
    case "continue":
      return at === "r5" || at === "r10" ? go(state, "r6", { retry: "connect" }) : state;
    case "slow":
      return at === "r6" ? go(state, "r7") : state;
    case "claim-refused":
      return PAIRING.includes(at) ? go(state, "r9") : state;
    case "network":
      return PAIRING.includes(at) || at === "r12" || at === "r14" ? go(state, "r10", { retry: "connect" }) : state;
    case "wrong-words":
      return PAIRING.includes(at) ? go(state, "r8") : state;
    case "paired":
      return PAIRING.includes(at) ? go(state, "r12", { checkWords: event.words }) : state;
    case "yes":
      return at === "r12" ? go(state, "r14") : state;
    case "no":
      return at === "r12" ? go(state, "r13", { checkWords: "" }) : state;
    case "details":
      return at === "r14" ? go(state, "r15", { fileName: event.name, fileSize: event.size, checkWords: "" }) : state;
    case "invalid-details":
      return at === "r14" ? go(state, "invalid") : state;
    case "too-big":
      return at === "r14" ? go(state, "r22") : state;
    case "expired":
      return BEFORE_FILE.includes(at) ? go(state, "r4", { checkWords: "" }) : state;
    case "download":
      return at === "r15" || at === "r19" || at === "r21" ? go(state, "r16", { received: 0, retry: "download" }) : state;
    case "progress":
      return at === "r16" ? { ...state, received: event.received } : state;
    case "checking":
      return at === "r16" ? go(state, "r17") : state;
    case "saved":
      return at === "r17" ? go(state, "r18") : state;
    case "save-failed":
      return at === "r17" || at === "r18" || at === "r23" ? go(state, "r23") : state;
    case "save-again":
      return at === "r23" ? go(state, "r18") : state;
    case "missing":
      return at === "r16" || at === "r17" ? go(state, "r20") : state;
    case "unavailable":
      return at === "r16" || at === "r17" ? go(state, "r19") : state;
    case "damaged":
      return at === "r16" || at === "r17" ? go(state, "r21") : state;
    case "back":
      return at === "r6" ? go(state, "r5") : state;
    case "cancel":
      if (at === "r16") return go(state, "r15", { received: 0 });
      return PAIRING.includes(at) || at === "r14" ? go(state, "cancelled", { checkWords: "" }) : state;
    default:
      return state;
  }
}
