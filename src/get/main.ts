import {
  createLiveRelayClient,
  createPairingFlow,
  init,
  parsePairingLink,
  type LiveRoom,
  type PairingFlow,
} from "@forgesworn/foregather-kit";
import { fetchVerifiedShare, parseShareDescriptor, ShareDescriptorError, type ShareDescriptor } from "../core/blossom.js";
import { decryptPrivacyEnvelope } from "../core/crypto.js";
import { PAIRING_NAMESPACE, PAIRING_PURPOSE, PAIRING_SERVICE, SLOW_SENDER_MS, allowsLoopbackHttp } from "./config.js";
import { COPY, formatBytes, formatClock } from "./copy.js";
import { classifyDownloadFailure, classifyPairingFailure } from "./failure.js";
import { classifyLinkFailure } from "./link.js";
import { createDownloadedReply, type DownloadedReply } from "./reply.js";
import { INITIAL_STATE, reduce, type ScreenId, type ViewEvent, type ViewState } from "./state.js";
import { applySuggestion, checkWords, REQUIRED_WORDS, parseWords } from "./words.js";
import "./get.css";

const NAMESPACE = PAIRING_NAMESPACE;
const PURPOSE = PAIRING_PURPOSE;
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
// The channel kept open after the share details arrive, for the one reply.
let replyFlow: DownloadedReply | undefined;
let secret: string | undefined;
let claimed = false;
let descriptor: ShareDescriptor | undefined;
let controller: AbortController | undefined;
let slowTimer: ReturnType<typeof setTimeout> | undefined;
let savedFile: File | undefined;
let objectUrl: string | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
let announcedStep = 0;

// Element references that change without a full render.
let wordsInput: HTMLInputElement | undefined;
let hintEl: HTMLElement | undefined;
let errorEl: HTMLElement | undefined;
let suggestionHost: HTMLElement | undefined;
let countdownEl: HTMLElement | undefined;
let progressEl: HTMLProgressElement | undefined;
let progressText: HTMLElement | undefined;

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
    return;
  }
  render(true);
}

function setTitle(h1: string): void {
  titleEl.textContent = h1;
  document.title = `${h1} · ${COPY.titleSuffix}`;
}

function renderBanner(): void {
  const showOn: readonly ScreenId[] = ["r5", "r10", "r15", "r19"];
  offlineEl.textContent = state.offline && showOn.includes(state.screen) ? COPY.offlineBanner : "";
}

function renderFooter(): void {
  const sameTab: readonly ScreenId[] = ["r2", "r3", "r4", "r18", "r20"];
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

function screenText(screen: ScreenId): { h1: string; body?: string } {
  const entry = COPY.screens[screen as keyof typeof COPY.screens] as { h1: string; body?: string | ((name: string) => string) };
  const body = typeof entry.body === "function" ? entry.body(state.fileName) : entry.body;
  return body === undefined ? { h1: entry.h1 } : { h1: entry.h1, body };
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
  wordsInput = hintEl = errorEl = suggestionHost = countdownEl = progressEl = progressText = undefined;
  const screen = state.screen;
  const text = screenText(screen);
  setTitle(text.h1);
  const view = document.createDocumentFragment();
  const addBody = (): void => { if (text.body) view.append(el("p", undefined, text.body)); };
  switch (screen) {
    case "r5":
      view.append(...enterWords(text.body ?? ""));
      break;
    case "r6":
      addBody();
      view.append(button(COPY.buttons.cancel, onCancelConnect, "secondary"));
      break;
    case "r7":
      addBody();
      view.append(timeLeftNote(), button(COPY.buttons.cancel, onCancelConnect, "secondary"));
      break;
    case "r10":
      addBody();
      view.append(button(COPY.buttons.tryAgain, () => { if (!blockedOffline()) void connect(); }));
      break;
    case "r12": {
      addBody();
      const list = el("ol", "words-list");
      list.setAttribute("aria-label", COPY.checkWordsLabel);
      for (const word of state.checkWords.split(" ")) list.append(el("li", undefined, word));
      view.append(list, button(COPY.buttons.yes, onYes), button(COPY.buttons.no, onNo, "secondary"));
      break;
    }
    case "r14":
      addBody();
      view.append(button(COPY.buttons.cancel, onCancelConnect, "secondary"));
      break;
    case "r15":
      view.append(el("p", "file-name", state.fileName), el("p", "file-size", formatBytes(state.fileSize)));
      view.append(button(COPY.buttons.download, onDownload));
      if (text.body) view.append(el("p", "muted small", text.body));
      break;
    case "r16":
      view.append(el("p", "file-name", state.fileName));
      progressEl = el("progress");
      progressEl.max = Math.max(1, descriptor?.size ?? 1);
      progressEl.value = 0;
      progressEl.setAttribute("aria-label", COPY.progressName);
      progressText = el("p", "muted small");
      view.append(progressEl, progressText, button(COPY.buttons.cancel, onCancelDownload, "secondary"));
      updateProgress();
      break;
    case "r17":
      addBody();
      break;
    case "r18":
      addBody();
      view.append(button(COPY.buttons.saveAgain, onSaveAgain));
      break;
    case "r19":
    case "r21":
      addBody();
      view.append(button(COPY.buttons.tryAgain, onDownload));
      break;
    case "r23":
      addBody();
      view.append(button(COPY.buttons.saveAgain, onSaveAgain));
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
  if (!progressEl || !progressText || !descriptor) return;
  progressEl.value = state.received;
  progressText.textContent = COPY.progressLabel(formatBytes(state.received), formatBytes(descriptor.size));
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
  return [el("p", undefined, lede), form, el("p", "muted", COPY.senderNeeds), timeLeftNote()];
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
    const transport = await relay.recipient({ locator: room.session.locator, signal: run.signal });
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
      transport,
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
  if (!before && state.screen === "r6") {
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
      // keepOpen holds the channel for the one reply sent once the file is saved.
      const payload = await active.receive({ signal: run.signal, keepOpen: true });
      let parsed: ShareDescriptor;
      try {
        parsed = parseShareDescriptor(payload);
      } finally {
        payload.fill(0);
      }
      if (run.signal.aborted) {
        active.dispose();
        return;
      }
      descriptor = parsed;
      flow = undefined;
      replyFlow = createDownloadedReply(active);
      dispatch({ type: "details", name: parsed.name, size: parsed.bytes });
    } catch (error) {
      active.dispose();
      if (run.signal.aborted) return;
      if (error instanceof ShareDescriptorError) {
        dispatch({ type: error.reason === "too-large" ? "too-big" : "invalid-details" });
        return;
      }
      const failure = classifyPairingFailure(error, true);
      dispatch({ type: failure === "expired" ? "expired" : "network" });
    }
  })();
}

// ------------------------------------------------------------------- download

function syncUnloadGuard(): void {
  const busy = state.screen === "r16" || state.screen === "r17";
  window.removeEventListener("beforeunload", beforeUnload);
  if (busy) window.addEventListener("beforeunload", beforeUnload);
}

function beforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
}

function onCancelDownload(): void {
  controller?.abort();
  dispatch({ type: "cancel" });
}

function onDownload(): void {
  const share = descriptor;
  if (!share || blockedOffline()) return;
  const run = new AbortController();
  controller = run;
  announcedStep = 0;
  dispatch({ type: "download" });
  void (async () => {
    if (share.expires <= nowSeconds()) {
      closeReply();
      dispatch({ type: "missing" });
      return;
    }
    let blob: Blob;
    try {
      blob = await fetchVerifiedShare(share, {
        signal: run.signal,
        onProgress: (received, total) => {
          dispatch({ type: "progress", received });
          const percent = Math.floor((received / total) * 100);
          const step = Math.floor(percent / 25);
          if (step > announcedStep && step < 4) {
            announcedStep = step;
            announce(COPY.announce.progress(step * 25));
          }
        },
      });
    } catch (error) {
      if (run.signal.aborted) return;
      const failure = classifyDownloadFailure(error, "fetch");
      // The file is gone, so nothing will be saved and the sender need not wait.
      if (failure === "missing") closeReply();
      dispatch({ type: failure });
      return;
    }
    if (run.signal.aborted) return;
    dispatch({ type: "checking" });
    announce(COPY.announce.downloaded);
    let file: File;
    try {
      file = await decryptPrivacyEnvelope(blob, share.key, run.signal);
      if (file.size !== share.bytes) throw new Error("size differs from the share details");
    } catch (error) {
      if (run.signal.aborted) return;
      dispatch({ type: classifyDownloadFailure(error, "open") });
      return;
    }
    savedFile = file;
    if (saveFile()) {
      dispatch({ type: "saved" });
      announce(COPY.announce.saved);
      tellSenderSaved();
    } else {
      dispatch({ type: "save-failed" });
    }
  })();
}

function saveFile(): boolean {
  if (!savedFile) return false;
  try {
    if (objectUrl === undefined) objectUrl = URL.createObjectURL(savedFile);
    const anchor = el("a");
    anchor.href = objectUrl;
    anchor.download = savedFile.name;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch {
    return false;
  }
}

/**
 * Called only once the file has been decrypted, matched its size and been
 * handed to the browser to save. Fire and forget: the screen never waits for
 * the sender, and a failed or late reply is not shown.
 */
function tellSenderSaved(): void {
  const pending = replyFlow;
  if (!pending) return;
  void pending.send().then(() => {
    if (replyFlow === pending) replyFlow = undefined;
  });
}

function onSaveAgain(): void {
  if (saveFile()) {
    if (state.screen === "r23") dispatch({ type: "save-again" });
    announce(COPY.announce.saved);
    tellSenderSaved();
  } else {
    dispatch({ type: "save-failed" });
  }
}

// ----------------------------------------------------------------- countdown

function syncCountdownTimer(): void {
  const live = state.screen === "r5" || state.screen === "r6" || state.screen === "r7" || state.screen === "r10" || state.screen === "r12" || state.screen === "r14";
  clearInterval(countdownTimer);
  countdownTimer = undefined;
  if (!live || !room) return;
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
    && typeof ReadableStream === "function";
}

async function start(): Promise<void> {
  window.addEventListener("online", () => dispatch({ type: "online", online: true }));
  window.addEventListener("offline", () => dispatch({ type: "online", online: false }));
  window.addEventListener("pagehide", () => {
    stopFlow();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
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
  const base = `${location.origin}/get/`;
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
