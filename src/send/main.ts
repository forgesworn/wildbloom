import {
  createLiveRelayClient,
  createPairingFlow,
  init,
  parsePairingLink,
  type LiveRoom,
  type PairingFlow,
} from "@forgesworn/foregather-kit";
import { envelopeBytes } from "../core/crypto.js";
import { DIRECT_ICE_ALLOWLIST, DIRECT_PURPOSE } from "../direct/config.js";
import { DirectError, fromPairingExchange, SenderSession, type DirectFailure } from "../direct/session.js";
import { PAIRING_NAMESPACE, PAIRING_SERVICE, SLOW_SENDER_MS, allowsLoopbackHttp } from "../get/config.js";
import { classifyPairingFailure } from "../get/failure.js";
import { classifyLinkFailure } from "../get/link.js";
import { applySuggestion, checkWords, REQUIRED_WORDS, parseWords } from "../get/words.js";
import "../get/get.css";
import "./send.css";
import { COPY, formatBytes, formatClock } from "./copy.js";
import { screenText } from "./screens.js";
import { prepareSource } from "./source.js";
import { INITIAL_STATE, reduce, type ScreenId, type ViewEvent, type ViewState } from "./state.js";
import { createScreenLock } from "./wakelock.js";

const NAMESPACE = PAIRING_NAMESPACE;
const PURPOSE = DIRECT_PURPOSE;
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element ${id}`);
  return element;
}

const titleEl = byId("title");
const viewEl = byId("view");
const offlineEl = byId("offline");
const liveEl = byId("live");
const footerEl = document.querySelector<HTMLElement>(".footer");
if (!footerEl) throw new Error("missing footer");

let state: ViewState = INITIAL_STATE;
let room: LiveRoom | undefined;
let flow: PairingFlow | undefined;
let session: SenderSession | undefined;
let secret: string | undefined;
let claimed = false;
let controller: AbortController | undefined;
let slowTimer: ReturnType<typeof setTimeout> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let announcedStep = 0;
const screenLock = createScreenLock();

// Element references that change without a full render.
let wordsInput: HTMLInputElement | undefined;
let hintEl: HTMLElement | undefined;
let errorEl: HTMLElement | undefined;
let suggestionHost: HTMLElement | undefined;
let countdownEl: HTMLElement | undefined;
let progressEl: HTMLProgressElement | undefined;
let progressText: HTMLElement | undefined;
let reconnectNote: HTMLElement | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void, kind: "primary" | "secondary" = "primary"): HTMLButtonElement {
  const node = el("button", kind === "primary" ? "button" : "button secondary", label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function announce(message: string): void {
  // Clear first so repeating a message is announced again.
  liveEl.textContent = "";
  window.setTimeout(() => { liveEl.textContent = message; }, 50);
}

function dispatch(event: ViewEvent): void {
  const next = reduce(state, event);
  if (next === state) return;
  const changed = next.screen !== state.screen;
  state = next;
  if (event.type === "online" || !changed) {
    renderBanner();
    if (event.type === "progress" || event.type === "reconnecting") {
      updateProgress();
      updateReconnectNote();
    }
    return;
  }
  render(true);
}

function setTitle(h1: string): void {
  titleEl.textContent = h1;
  document.title = `${h1} · ${COPY.titleSuffix}`;
}

function renderBanner(): void {
  const showOn: readonly ScreenId[] = ["words", "network", "choose"];
  offlineEl.textContent = state.offline && showOn.includes(state.screen) ? COPY.offlineBanner : "";
}

function renderFooter(): void {
  const sameTab: readonly ScreenId[] = ["unsupported", "incomplete", "expired", "sent", "declined"];
  footerEl!.replaceChildren();
  footerEl!.append(el("p", undefined, COPY.footer));
  const link = el("a", undefined, COPY.aboutLink);
  link.href = "/";
  if (!sameTab.includes(state.screen)) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  footerEl!.append(link);
}

function timeLeftNote(): HTMLElement {
  countdownEl = el("p", "muted");
  updateCountdown();
  return countdownEl;
}

function updateCountdown(): void {
  if (!countdownEl || !room) return;
  countdownEl.textContent = COPY.timeLeft(formatClock(room.session.expires - nowSeconds()));
}

function render(moveFocus: boolean): void {
  wordsInput = hintEl = errorEl = suggestionHost = countdownEl = progressEl = progressText = reconnectNote = undefined;
  const screen = state.screen;
  const text = screenText(state);
  setTitle(text.h1);
  const view = document.createDocumentFragment();
  const addBody = (): void => { if (text.body) view.append(el("p", undefined, text.body)); };
  switch (screen) {
    case "words":
      view.append(...enterWords(text.body ?? ""));
      break;
    case "connecting":
      addBody();
      view.append(button(COPY.buttons.cancel, onCancelConnect, "secondary"));
      break;
    case "waiting":
      addBody();
      view.append(timeLeftNote(), button(COPY.buttons.cancel, onCancelConnect, "secondary"));
      break;
    case "network":
      addBody();
      view.append(button(COPY.buttons.tryAgain, () => { if (!blockedOffline()) void connect(); }));
      break;
    case "check": {
      addBody();
      const list = el("ol", "words-list");
      list.setAttribute("aria-label", COPY.checkWordsLabel);
      for (const word of state.checkWords.split(" ")) list.append(el("li", undefined, word));
      view.append(list, button(COPY.buttons.yes, onYes), button(COPY.buttons.no, onNo, "secondary"));
      break;
    }
    case "confirming":
      addBody();
      view.append(button(COPY.buttons.cancel, onCancelConnect, "secondary"));
      break;
    case "choose":
      addBody();
      view.append(...hideOption(), ...filePicker(COPY.buttons.chooseFile), button(COPY.buttons.cancel, onStop, "secondary"), timeLeftNote());
      break;
    case "too-big":
    case "empty":
    case "unreadable":
      addBody();
      view.append(...hideOption(), ...filePicker(COPY.buttons.chooseAnother), button(COPY.buttons.cancel, onStop, "secondary"), timeLeftNote());
      break;
    case "asking":
    case "linking":
      addBody();
      view.append(button(COPY.buttons.stop, onStop, "secondary"));
      break;
    case "sending":
      progressEl = el("progress");
      progressEl.max = Math.max(1, state.total);
      progressEl.value = 0;
      progressEl.setAttribute("aria-label", COPY.progressName);
      progressText = el("p", "muted small");
      reconnectNote = el("p", "muted small");
      reconnectNote.setAttribute("role", "status");
      view.append(progressEl, progressText, reconnectNote);
      addBody();
      view.append(button(COPY.buttons.stop, onStop, "secondary"));
      updateProgress();
      updateReconnectNote();
      break;
    case "finishing":
      // The end of the file has gone and the receiver has not yet said it is kept. Stopping is still honest: the page
      // then says the outcome is not known.
      reconnectNote = el("p", "muted small");
      reconnectNote.setAttribute("role", "status");
      view.append(reconnectNote);
      addBody();
      view.append(button(COPY.buttons.stop, onStop, "secondary"));
      updateReconnectNote();
      break;
    default:
      addBody();
  }
  viewEl.replaceChildren(view);
  renderBanner();
  renderFooter();
  syncCountdownTimer();
  syncUnloadGuard();
  if (moveFocus) titleEl.focus();
}

/** Progress is what the other end has acknowledged, shown against the file's own size. */
function updateProgress(): void {
  if (!progressEl || !progressText) return;
  progressEl.value = state.sent;
  const done = state.total > 0 ? Math.min(state.fileSize, Math.floor((state.sent / state.total) * state.fileSize)) : 0;
  progressText.textContent = COPY.progressLabel(formatBytes(done), formatBytes(state.fileSize));
}

function updateReconnectNote(): void {
  if (reconnectNote) reconnectNote.textContent = state.reconnecting ? COPY.reconnecting : "";
}

// ---------------------------------------------------------------- enter words

function enterWords(lede: string): HTMLElement[] {
  const form = el("form");
  form.noValidate = true;
  const label = el("label", undefined, COPY.wordsLabel);
  label.htmlFor = "words";
  const input = el("input");
  input.type = "text";
  input.id = "words";
  input.name = "words";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocapitalize", "none");
  input.setAttribute("autocorrect", "off");
  input.spellcheck = false;
  input.inputMode = "text";
  input.enterKeyHint = "go";
  input.setAttribute("aria-describedby", "words-hint words-error");
  input.value = secret ?? "";
  const hint = el("p", "hint");
  hint.id = "words-hint";
  const error = el("p", "field-error");
  error.id = "words-error";
  error.setAttribute("role", "alert");
  const suggestion = el("div");
  wordsInput = input;
  hintEl = hint;
  errorEl = error;
  suggestionHost = suggestion;
  updateHint(false);
  input.addEventListener("input", () => { clearFieldError(); updateHint(true); });
  input.addEventListener("focus", () => {
    window.setTimeout(() => input.scrollIntoView({ block: "center" }), 250);
  });
  const submit = el("button", "button", COPY.buttons.continue);
  submit.type = "submit";
  form.append(label, input, hint, error, suggestion, submit);
  form.addEventListener("submit", (event) => { event.preventDefault(); onContinue(); });
  return [el("p", undefined, lede), form, el("p", "muted", COPY.theyNeed), timeLeftNote()];
}

let hintAnnounceAt = 0;
let hintAnnounceTimer: ReturnType<typeof setTimeout> | undefined;

function updateHint(announceIt: boolean): void {
  if (!hintEl || !wordsInput) return;
  const count = Math.min(parseWords(wordsInput.value).length, REQUIRED_WORDS);
  const message = COPY.words.hint(count);
  hintEl.textContent = message;
  if (!announceIt) return;
  // Politely, and at most once a second while typing.
  const wait = Math.max(0, hintAnnounceAt + 1000 - Date.now());
  clearTimeout(hintAnnounceTimer);
  hintAnnounceTimer = setTimeout(() => {
    hintAnnounceAt = Date.now();
    announce(hintEl?.textContent ?? message);
  }, wait);
}

function clearFieldError(): void {
  if (!wordsInput || !errorEl || !suggestionHost) return;
  errorEl.textContent = "";
  suggestionHost.replaceChildren();
  wordsInput.removeAttribute("aria-invalid");
}

function showFieldError(message: string): void {
  if (!wordsInput || !errorEl) return;
  errorEl.textContent = message;
  wordsInput.setAttribute("aria-invalid", "true");
  wordsInput.focus();
}

function blockedOffline(): boolean {
  if (!state.offline) return false;
  renderBanner();
  return true;
}

function onContinue(): void {
  if (!wordsInput || !suggestionHost) return;
  clearFieldError();
  if (blockedOffline()) return;
  const result = checkWords(wordsInput.value);
  if (result.ok) {
    secret = result.secret;
    void connect();
    return;
  }
  if (result.problem === "empty") showFieldError(COPY.words.empty);
  else if (result.problem === "count") showFieldError(COPY.words.wrongCount(result.count));
  else {
    showFieldError(COPY.words.unknown(result.word));
    if (result.suggestion) {
      const { index, suggestion } = result;
      const use = button(COPY.words.useSuggestion(suggestion), () => {
        if (!wordsInput) return;
        wordsInput.value = applySuggestion(wordsInput.value, index, suggestion);
        clearFieldError();
        updateHint(true);
        wordsInput.focus();
      }, "secondary");
      use.classList.add("suggestion");
      suggestionHost.append(use);
    }
  }
}

// --------------------------------------------------------------- pairing flow

/** Set while the page is being hidden: the requests it starts then, such as the stop, are allowed to outlive it. */
let leaving = false;
const relay = createLiveRelayClient({
  apiUrl: PAIRING_SERVICE,
  allowLoopbackHttp: allowsLoopbackHttp(PAIRING_SERVICE),
  fetch: (input, init) => fetch(input, leaving ? { ...init, keepalive: true } : init),
});

function stopFlow(): void {
  clearTimeout(slowTimer);
  controller?.abort();
  flow?.dispose();
  flow = undefined;
}

async function connect(): Promise<void> {
  if (!room || secret === undefined) return;
  stopFlow();
  claimed = false;
  const run = new AbortController();
  controller = run;
  dispatch({ type: "continue" });
  try {
    const link = await relay.recipient({ locator: room.session.locator, signal: run.signal });
    claimed = true;
    announce(COPY.announce.connected);
    slowTimer = setTimeout(() => dispatch({ type: "slow" }), SLOW_SENDER_MS);
    const pairing = createPairingFlow({
      session: room.session,
      secretWords: secret,
      role: "recipient",
      namespace: NAMESPACE,
      purpose: PURPOSE,
      now: nowSeconds,
      transport: link,
      onState: ({ state: next }) => { if (next === "expired") dispatch({ type: "expired" }); },
    });
    flow = pairing;
    const words = await pairing.pair({ signal: run.signal });
    clearTimeout(slowTimer);
    secret = undefined;
    dispatch({ type: "paired", words });
  } catch (error) {
    clearTimeout(slowTimer);
    if (run.signal.aborted) return;
    const failure = classifyPairingFailure(error, claimed);
    if (failure === "claim-refused") dispatch({ type: "claim-refused" });
    else if (failure === "wrong-words") { secret = undefined; dispatch({ type: "wrong-words" }); }
    else if (failure === "expired") dispatch({ type: "expired" });
    else if (failure === "network") dispatch({ type: "network" });
  }
}

function onCancelConnect(): void {
  const before = claimed;
  stopFlow();
  if (!before && state.screen === "connecting") {
    dispatch({ type: "back" });
    return;
  }
  secret = undefined;
  const active = session;
  session = undefined;
  active?.stop("cancelled");
  dispatch({ type: "cancel" });
}

function onNo(): void {
  flow?.verify({ matches: false });
  flow = undefined;
  secret = undefined;
  dispatch({ type: "no" });
}

/** What each way the session can end says on screen. */
const SCREEN_FOR_FAILURE: Readonly<Record<DirectFailure, ViewEvent["type"] | "ignore">> = {
  cancelled: "ignore",
  "peer-cancelled": "they-stopped",
  declined: "declined",
  unsupported: "failed",
  "peer-unsupported": "failed",
  protocol: "failed",
  "peer-failed": "failed",
  "peer-storage": "no-room",
  "no-relay": "no-relay",
  connect: "connect-failed",
  lost: "lost",
  expired: "expired",
  network: "lost",
  source: "failed",
  "too-big": "failed",
  verification: "failed",
  storage: "failed",
};

function showFailure(error: unknown): void {
  const kind: DirectFailure = error instanceof DirectError ? error.kind : "protocol";
  // An invitation this page cannot use is told apart from a session that failed later.
  const event = kind === "unsupported" && state.screen === "confirming" ? "invalid-invitation" : SCREEN_FOR_FAILURE[kind];
  if (event === "ignore") return;
  finish();
  dispatch({ type: event } as ViewEvent);
}

function onYes(): void {
  const active = flow;
  if (!active || !controller) return;
  active.verify({ matches: true });
  dispatch({ type: "yes" });
  flow = undefined;
  clearTimeout(slowTimer);
  const next = new SenderSession({ exchange: fromPairingExchange(active.exchange()), iceAllowlist: DIRECT_ICE_ALLOWLIST });
  session = next;
  void (async () => {
    try {
      const invite = await next.readInvite();
      if (session !== next) return;
      dispatch({ type: "invitation", maxBytes: invite.max, theirHidden: invite.hide });
    } catch (error) {
      if (session !== next) return;
      // An invitation this page cannot use is told apart from a session that ran out or a connection that was lost.
      showFailure(error);
    }
  })();
}

// ------------------------------------------------------------- choose and send

function hideOption(): HTMLElement[] {
  const row = el("label", "check");
  const box = el("input");
  box.type = "checkbox";
  box.id = "hide";
  box.checked = state.hide;
  box.setAttribute("aria-describedby", "hide-hint");
  box.addEventListener("change", () => dispatch({ type: "hide", on: box.checked }));
  row.append(box, el("span", undefined, COPY.hide.label));
  const hint = el("p", "muted small");
  hint.id = "hide-hint";
  hint.textContent = state.theirHidden ? `${COPY.hide.hint} ${COPY.hide.theirs}` : COPY.hide.hint;
  return [row, hint];
}

function filePicker(label: string): HTMLElement[] {
  const input = el("input");
  input.type = "file";
  input.id = "file";
  input.hidden = true;
  input.tabIndex = -1;
  input.addEventListener("change", () => {
    const [chosen] = input.files ?? [];
    // Reset so choosing the same file again still fires a change.
    input.value = "";
    if (chosen) void onFileChosen(chosen);
  });
  return [input, button(label, () => {
    if (blockedOffline()) return;
    input.click();
  })];
}

const PICKING_SCREENS: readonly ScreenId[] = ["choose", "too-big", "empty", "unreadable"];

async function onFileChosen(chosen: File): Promise<void> {
  const active = session;
  if (!active || !PICKING_SCREENS.includes(state.screen)) return;
  if (chosen.size === 0) {
    dispatch({ type: "empty" });
    return;
  }
  if (chosen.size > state.maxBytes) {
    dispatch({ type: "too-big" });
    return;
  }
  // The name and type are brought within what Drop's reader accepts; the bytes are not copied.
  const source = prepareSource(chosen);
  screenLock.hold();
  dispatch({ type: "asking", name: source.name, size: source.size });
  announce(COPY.announce.asking(source.name));
  announcedStep = 0;
  try {
    const decision = await active.offer({ name: source.name, size: source.size, type: source.type });
    if (session !== active) return;
    if (decision === "declined") {
      finish();
      dispatch({ type: "declined" });
      return;
    }
    await active.send(source, {
      hide: state.hide,
      onConnecting: () => dispatch({ type: "linking" }),
      onConnected: () => {
        dispatch({ type: "sending", total: totalFor(source) });
        announce(COPY.announce.sending(source.name));
      },
      onEndSent: () => {
        dispatch({ type: "end-sent" });
        announce(COPY.announce.finishing);
      },
      onProgress: (acknowledged, total) => {
        dispatch({ type: "progress", sent: acknowledged });
        const step = Math.floor((acknowledged / total) * 100 / 25);
        if (step > announcedStep && step < 4) {
          announcedStep = step;
          announce(COPY.announce.progress(step * 25));
        }
      },
      onReconnecting: (on) => dispatch({ type: "reconnecting", on }),
    });
    if (session !== active) return;
    finish();
    dispatch({ type: "sent" });
    announce(COPY.announce.sent);
  } catch (error) {
    if (session !== active) return;
    showFailure(error);
  }
}

/** The envelope length, known from the manifest alone. */
function totalFor(source: File): number {
  return envelopeBytes(source.name, source.type, source.size);
}

function onStop(): void {
  const active = session;
  session = undefined;
  active?.stop("cancelled");
  finish();
  dispatch({ type: "cancel" });
}

/** The session is over, one way or another: nothing stays in memory and the screen may sleep. */
function finish(): void {
  screenLock.release();
  const active = session;
  session = undefined;
  active?.close();
}

// ------------------------------------------------------------------- guards

function syncUnloadGuard(): void {
  const busy = state.screen === "asking" || state.screen === "linking" || state.screen === "sending" || state.screen === "finishing";
  window.removeEventListener("beforeunload", beforeUnload);
  if (busy) window.addEventListener("beforeunload", beforeUnload);
}

function beforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
}

// ----------------------------------------------------------------- countdown

function syncCountdownTimer(): void {
  const live: readonly ScreenId[] = ["words", "connecting", "waiting", "network", "check", "confirming", "choose", "too-big", "empty", "unreadable"];
  clearInterval(countdownTimer);
  countdownTimer = undefined;
  if (!live.includes(state.screen) || !room) return;
  countdownTimer = setInterval(() => {
    if (!room) return;
    if (room.session.expires <= nowSeconds()) {
      stopFlow();
      secret = undefined;
      const active = session;
      session = undefined;
      active?.stop("cancelled");
      dispatch({ type: "expired" });
      return;
    }
    updateCountdown();
  }, 1000);
}

// -------------------------------------------------------------------- start up

function supported(): boolean {
  return typeof WebAssembly === "object"
    && typeof crypto !== "undefined" && typeof crypto.subtle === "object"
    && typeof BigInt === "function"
    && typeof ReadableStream === "function"
    && typeof RTCPeerConnection === "function"
    && typeof File === "function";
}

async function start(): Promise<void> {
  window.addEventListener("online", () => dispatch({ type: "online", online: true }));
  window.addEventListener("offline", () => dispatch({ type: "online", online: false }));
  window.addEventListener("pagehide", () => {
    leaving = true;
    stopFlow();
    // Tell the other end at once and close the connection in this turn: there may be no later one.
    // The stop's request starts in the microtasks straight after this handler, before the page goes, and the
    // session keeps its exchange open until that request has gone.
    const active = session;
    session = undefined;
    active?.stop("cancelled", { immediate: true });
    screenLock.release();
  });
  // A page brought back from the back-forward cache is no longer leaving.
  window.addEventListener("pageshow", () => { leaving = false; });
  dispatch({ type: "online", online: navigator.onLine });
  if (!supported()) {
    dispatch({ type: "unsupported" });
    return;
  }
  try {
    await init();
  } catch {
    dispatch({ type: "unsupported" });
    return;
  }
  const base = `${location.origin}/send/`;
  try {
    const parsed = parsePairingLink({
      url: `${base}${location.hash}`,
      baseUrl: base,
      namespace: NAMESPACE,
      purpose: PURPOSE,
      now: nowSeconds(),
      allowLoopbackHttp: location.protocol === "http:",
    });
    if (parsed.secret_format !== "words") throw new Error("not a word link");
    room = parsed;
  } catch {
    const problem = classifyLinkFailure(location.hash, nowSeconds());
    dispatch({ type: "start", link: problem });
    return;
  }
  render(false);
}

void start();
