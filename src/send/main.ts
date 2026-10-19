import {
  createLiveRelayClient,
  createPairingFlow,
  init,
  parsePairingLink,
  type LiveRoom,
  type PairingFlow,
} from "@forgesworn/foregather-kit";
import { encryptPrivacyEnvelope, envelopeBytes, sha256Hex } from "../core/crypto.js";
import { PAIRING_NAMESPACE, PAIRING_SERVICE, REQUEST_PAIRING_PURPOSE, SLOW_SENDER_MS, allowsLoopbackHttp } from "../get/config.js";
import { classifyPairingFailure } from "../get/failure.js";
import { classifyLinkFailure } from "../get/link.js";
import { applySuggestion, checkWords, REQUIRED_WORDS, parseWords } from "../get/words.js";
import "../get/get.css";
import { COPY, formatBytes, formatClock } from "./copy.js";
import { parseRequestInvitation, RequestInvitationError, type RequestInvitation } from "./request.js";
import { createEarlyReply, type EarlyReply } from "./reply.js";
import { prepareSource } from "./source.js";
import { INITIAL_STATE, reduce, type ScreenId, type ViewEvent, type ViewState } from "./state.js";
import { createBrowserTransport, UploadError, uploadEnvelope, withRetries } from "./upload.js";
import { createScreenLock } from "./wakelock.js";

const NAMESPACE = PAIRING_NAMESPACE;
const PURPOSE = REQUEST_PAIRING_PURPOSE;
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
// The channel kept open after the invitation arrives, for the one early reply.
let replyFlow: EarlyReply | undefined;
let secret: string | undefined;
let claimed = false;
// The two secrets of the request live only here, in page memory, until the file is sent or the request ends.
let invitation: RequestInvitation | undefined;
let envelope: File | undefined;
let envelopeSha256: string | undefined;
let controller: AbortController | undefined;
let slowTimer: ReturnType<typeof setTimeout> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let untilTimer: ReturnType<typeof setInterval> | undefined;
let announcedStep = 0;
const transport = createBrowserTransport();
const screenLock = createScreenLock();

// Element references that change without a full render.
let wordsInput: HTMLInputElement | undefined;
let hintEl: HTMLElement | undefined;
let errorEl: HTMLElement | undefined;
let suggestionHost: HTMLElement | undefined;
let countdownEl: HTMLElement | undefined;
let progressEl: HTMLProgressElement | undefined;
let progressText: HTMLElement | undefined;
let retryNote: HTMLElement | undefined;

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
    if (event.type === "progress") updateProgress();
    if (event.type === "retrying") {
      updateProgress();
      updateRetryNote();
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
  const showOn: readonly ScreenId[] = ["words", "network", "choose", "stopped"];
  offlineEl.textContent = state.offline && showOn.includes(state.screen) ? COPY.offlineBanner : "";
}

function renderFooter(): void {
  const sameTab: readonly ScreenId[] = ["unsupported", "incomplete", "expired", "sent", "ended"];
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

function limitText(): string {
  return formatBytes(state.maxBytes);
}

/** The heading and lede of a screen. Headings that name the file are written from the state. */
function screenText(screen: ScreenId): { h1: string; body?: string } {
  const copy = COPY.screens;
  switch (screen) {
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
    case "choose": return { h1: copy.choose.h1, body: copy.choose.body(limitText()) };
    case "preparing": return { h1: copy.preparing.h1, body: copy.preparing.body(state.fileName) };
    case "sending": return { h1: copy.sending.h1(state.fileName), body: copy.sending.body };
    case "sent": return { h1: copy.sent.h1, body: copy.sent.body(state.fileName) };
    case "too-big": return { h1: copy.tooBig.h1, body: copy.tooBig.body(limitText()) };
    case "empty": return copy.empty;
    case "unreadable": return copy.unreadable;
    case "no-room": return copy.noRoom;
    case "stopped": return state.clockHint ? copy.stoppedClock : copy.stopped;
    case "ended": return copy.ended;
    case "cancelled": return copy.cancelled;
    case "invalid": return copy.invalid;
  }
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
  wordsInput = hintEl = errorEl = suggestionHost = countdownEl = progressEl = progressText = retryNote = undefined;
  const screen = state.screen;
  const text = screenText(screen);
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
      view.append(...filePicker(COPY.buttons.chooseFile));
      break;
    case "preparing":
      addBody();
      break;
    case "sending":
      progressEl = el("progress");
      progressEl.max = Math.max(1, state.total);
      progressEl.value = 0;
      progressEl.setAttribute("aria-label", COPY.progressName);
      progressText = el("p", "muted small");
      retryNote = el("p", "muted small");
      retryNote.setAttribute("role", "status");
      view.append(progressEl, progressText, retryNote);
      addBody();
      updateProgress();
      updateRetryNote();
      break;
    case "too-big":
    case "empty":
    case "unreadable":
    case "no-room":
      addBody();
      view.append(...filePicker(COPY.buttons.chooseAnother));
      break;
    case "stopped":
      addBody();
      view.append(button(COPY.buttons.tryAgain, onTryAgain));
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

function updateProgress(): void {
  if (!progressEl || !progressText) return;
  progressEl.value = state.sent;
  progressText.textContent = COPY.progressLabel(formatBytes(state.sent), formatBytes(state.total));
}

function updateRetryNote(): void {
  if (retryNote) retryNote.textContent = state.retrying ? COPY.retrying : "";
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

const relay = createLiveRelayClient({ apiUrl: PAIRING_SERVICE, allowLoopbackHttp: allowsLoopbackHttp(PAIRING_SERVICE) });

function closeReply(): void {
  replyFlow?.dispose();
  replyFlow = undefined;
}

function stopFlow(): void {
  clearTimeout(slowTimer);
  controller?.abort();
  flow?.dispose();
  flow = undefined;
  closeReply();
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
  dispatch({ type: "cancel" });
}

function onNo(): void {
  flow?.verify({ matches: false });
  flow = undefined;
  secret = undefined;
  dispatch({ type: "no" });
}

function onYes(): void {
  const active = flow;
  if (!active || !controller) return;
  const run = controller;
  active.verify({ matches: true });
  dispatch({ type: "yes" });
  void (async () => {
    try {
      // keepOpen holds the channel for the one early reply sent once the file is locked.
      const payload = await active.receive({ signal: run.signal, keepOpen: true });
      let parsed: RequestInvitation;
      try {
        parsed = parseRequestInvitation(payload, nowSeconds());
      } finally {
        payload.fill(0);
      }
      if (run.signal.aborted) {
        parsed.dispose();
        active.dispose();
        return;
      }
      invitation = parsed;
      flow = undefined;
      replyFlow = createEarlyReply(active);
      armUntilTimer();
      dispatch({ type: "invitation", maxBytes: parsed.bytes });
    } catch (error) {
      active.dispose();
      if (run.signal.aborted) return;
      if (error instanceof RequestInvitationError) {
        // A grant that has already run out is a request that ended; anything else is not a request this page can use.
        dispatch({ type: error.reason === "until" ? "ended" : "invalid-invitation" });
        return;
      }
      const failure = classifyPairingFailure(error, true);
      dispatch({ type: failure === "expired" ? "expired" : "network" });
    }
  })();
}

// ------------------------------------------------------------- choose and send

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
    if (state.screen === "choose" && blockedOffline()) return;
    input.click();
  })];
}

async function onFileChosen(chosen: File): Promise<void> {
  const request = invitation;
  if (!request || !PICKING_SCREENS.includes(state.screen)) return;
  if (chosen.size === 0) {
    dispatch({ type: "empty" });
    return;
  }
  if (chosen.size > request.bytes) {
    dispatch({ type: "too-big" });
    return;
  }
  const source = prepareSource(chosen);
  let sealedSize: number;
  try {
    sealedSize = envelopeBytes(source.name, source.type, source.size);
  } catch {
    dispatch({ type: "unreadable" });
    return;
  }
  if (sealedSize > request.size) {
    dispatch({ type: "too-big" });
    return;
  }
  const run = new AbortController();
  controller = run;
  envelope = undefined;
  envelopeSha256 = undefined;
  dispatch({ type: "preparing", name: source.name });
  announce(COPY.announce.preparing(source.name));
  screenLock.hold();
  let sealedFile: File;
  let digest: string;
  try {
    const sealed = await encryptPrivacyEnvelope(source, { key: request.key, signal: run.signal });
    sealedFile = sealed.file;
    digest = await sha256Hex(sealedFile, run.signal);
  } catch {
    if (run.signal.aborted) return;
    screenLock.release();
    dispatch({ type: "unreadable" });
    return;
  }
  if (run.signal.aborted) return;
  if (sealedFile.size > request.size) {
    screenLock.release();
    dispatch({ type: "too-big" });
    return;
  }
  envelope = sealedFile;
  envelopeSha256 = digest;
  // Early feedback for Drop, best effort: the upload never waits for it.
  void replyFlow?.send(digest, sealedFile.size).then(() => { replyFlow = undefined; });
  await sendEnvelope(run);
}

const PICKING_SCREENS: readonly ScreenId[] = ["choose", "too-big", "empty", "unreadable", "no-room"];

function onTryAgain(): void {
  if (!invitation || !envelope || blockedOffline()) return;
  const run = new AbortController();
  controller = run;
  screenLock.hold();
  void sendEnvelope(run);
}

async function sendEnvelope(run: AbortController): Promise<void> {
  const request = invitation;
  const sealed = envelope;
  const digest = envelopeSha256;
  if (!request || !sealed || !digest) return;
  announcedStep = 0;
  dispatch({ type: "sending", total: sealed.size });
  try {
    await withRetries({
      until: request.until,
      signal: run.signal,
      onWait: () => dispatch({ type: "retrying", on: true }),
      attempt: () => uploadEnvelope({
        invitation: request,
        envelope: sealed,
        sha256: digest,
        transport,
        signal: run.signal,
        onProgress: (sent, total) => {
          dispatch({ type: "progress", sent });
          const step = Math.floor((sent / total) * 100 / 25);
          if (step > announcedStep && step < 4) {
            announcedStep = step;
            announce(COPY.announce.progress(step * 25));
          }
        },
      }),
    });
  } catch (error) {
    if (run.signal.aborted) return;
    screenLock.release();
    const failure = error instanceof UploadError ? error.failure : "network";
    if (failure === "ended") {
      dispatch({ type: "ended" });
      finish();
    } else if (failure === "no-room") {
      envelope = undefined;
      envelopeSha256 = undefined;
      dispatch({ type: "no-room" });
    } else {
      dispatch({ type: "stopped", clockHint: failure === "unauthorised" });
    }
    return;
  }
  screenLock.release();
  dispatch({ type: "sent" });
  announce(COPY.announce.sent);
  finish();
}

/** The request is over, one way or another: nothing secret stays in memory. */
function finish(): void {
  clearInterval(untilTimer);
  untilTimer = undefined;
  invitation?.dispose();
  invitation = undefined;
  envelope = undefined;
  envelopeSha256 = undefined;
  closeReply();
  screenLock.release();
}

/** When the grant ends the request ends, unless the file is already on its way. */
function armUntilTimer(): void {
  clearInterval(untilTimer);
  untilTimer = setInterval(() => {
    if (!invitation || nowSeconds() < invitation.until || state.screen === "sending") return;
    controller?.abort();
    dispatch({ type: "ended" });
    finish();
  }, 1000);
}

// ------------------------------------------------------------------- guards

function syncUnloadGuard(): void {
  const busy = state.screen === "preparing" || state.screen === "sending";
  window.removeEventListener("beforeunload", beforeUnload);
  if (busy) window.addEventListener("beforeunload", beforeUnload);
}

function beforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
}

// ----------------------------------------------------------------- countdown

function syncCountdownTimer(): void {
  const live: readonly ScreenId[] = ["words", "connecting", "waiting", "network", "check", "confirming"];
  clearInterval(countdownTimer);
  countdownTimer = undefined;
  if (!live.includes(state.screen) || !room) return;
  countdownTimer = setInterval(() => {
    if (!room) return;
    if (room.session.expires <= nowSeconds()) {
      stopFlow();
      secret = undefined;
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
    && typeof XMLHttpRequest === "function"
    && typeof File === "function";
}

async function start(): Promise<void> {
  window.addEventListener("online", () => dispatch({ type: "online", online: true }));
  window.addEventListener("offline", () => dispatch({ type: "online", online: false }));
  window.addEventListener("pagehide", () => {
    stopFlow();
    finish();
  });
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
