import "./style.css";
import { buildBlossomUri, fetchVerifiedBlob, inspectFile, uploadToBlossom } from "./core/blossom.js";
import { decryptPrivacyEnvelope, encryptPrivacyEnvelope, type EncryptedEnvelope } from "./core/crypto.js";
import { buildFileEvent, buildTorrentEvent, parseSignedEventJson, signEventExactly } from "./core/nostr.js";
import { publishToRelays, resolveFromRelays } from "./core/relay.js";
import {
  assertHex64,
  normaliseBlossomServer,
  normaliseRelayUrl,
  normaliseTrackerUrl,
  parseEndpointList,
  safeDiagnostic,
} from "./core/security.js";
import { downloadFromSwarm, startBrowserSeeding } from "./core/swarm.js";
import { createHybridTorrent } from "./core/torrent.js";
import type {
  BlobDescriptor,
  EventTemplate,
  HybridPublication,
  InspectedFile,
  NetworkProfile,
  ResolvedHybridEvent,
  SignedNostrEvent,
  SignerPort,
  StopHandle,
  TorrentPlan,
} from "./core/types.js";

declare global {
  interface Window {
    nostr?: SignerPort;
  }
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing required element: ${id}`);
  return found as T;
}

const blossomInput = element<HTMLInputElement>("blossom-server");
const relayInput = element<HTMLTextAreaElement>("relay-urls");
const trackerInput = element<HTMLTextAreaElement>("tracker-urls");
const trackerField = element<HTMLElement>("tracker-field");
const iceBoundary = element<HTMLElement>("ice-boundary");
const torBoundary = element<HTMLElement>("tor-boundary");
const torConsentField = element<HTMLElement>("tor-consent-field");
const torConsent = element<HTMLInputElement>("tor-consent");
const connectSignerButton = element<HTMLButtonElement>("connect-signer");
const signerStatus = element<HTMLOutputElement>("signer-status");
const externalSignerIdentity = element<HTMLElement>("external-signer-identity");
const externalPubkeyInput = element<HTMLInputElement>("external-signer-pubkey");
const externalSigningPanel = element<HTMLElement>("external-signing-panel");
const externalSigningPurpose = element<HTMLElement>("external-signing-purpose");
const externalUnsignedEvent = element<HTMLTextAreaElement>("external-unsigned-event");
const externalSignedEvent = element<HTMLTextAreaElement>("external-signed-event");
const externalSigningLinks = element<HTMLDivElement>("external-signing-links");
const acceptExternalSignatureButton = element<HTMLButtonElement>("accept-external-signature");
const cancelExternalSignatureButton = element<HTMLButtonElement>("cancel-external-signature");
const publishStatus = element<HTMLOutputElement>("publish-status");
const retrieveStatus = element<HTMLOutputElement>("retrieve-status");
const fileInput = element<HTMLInputElement>("publish-file");
const protectFile = element<HTMLInputElement>("protect-file");
const eventIdInput = element<HTMLInputElement>("event-id");
const replicaInput = element<HTMLInputElement>("replica-server");
const fileFacts = element<HTMLDListElement>("file-facts");
const resolvedFacts = element<HTMLDListElement>("resolved-facts");
const publishLinks = element<HTMLDivElement>("publish-links");
const recoveryLinks = element<HTMLDivElement>("recovery-links");
const retrieveLinks = element<HTMLDivElement>("retrieve-links");
const recoveryKeyPanel = element<HTMLElement>("recovery-key-panel");
const recoveryKeyOutput = element<HTMLInputElement>("recovery-key-output");
const toggleRecoveryKey = element<HTMLButtonElement>("toggle-recovery-key");
const recoveryKeyField = element<HTMLElement>("recovery-key-field");
const recoveryKeyInput = element<HTMLInputElement>("recovery-key-input");
const uploadConsentCopy = element<HTMLElement>("upload-consent-copy");
const signEventCopy = element<HTMLElement>("sign-event-copy");
const seedGate = element<HTMLElement>("seed-gate");

const uploadConsent = element<HTMLInputElement>("upload-consent");
const keySavedConsent = element<HTMLInputElement>("key-saved-consent");
const seedConsent = element<HTMLInputElement>("seed-consent");
const publishConsent = element<HTMLInputElement>("publish-consent");
const swarmConsent = element<HTMLInputElement>("download-swarm-consent");

const uploadButton = element<HTMLButtonElement>("upload-file");
const cancelUploadButton = element<HTMLButtonElement>("cancel-upload");
const seedButton = element<HTMLButtonElement>("start-seeding");
const stopSeedButton = element<HTMLButtonElement>("stop-seeding");
const signButton = element<HTMLButtonElement>("sign-events");
const publishButton = element<HTMLButtonElement>("publish-events");
const resolveButton = element<HTMLButtonElement>("resolve-event");
const blossomFetchButton = element<HTMLButtonElement>("fetch-blossom");
const swarmFetchButton = element<HTMLButtonElement>("fetch-swarm");
const cancelDownloadButton = element<HTMLButtonElement>("cancel-download");

let pubkey: string | null = null;
let sourceInspected: InspectedFile | null = null;
let inspected: InspectedFile | null = null;
let protectedEnvelope: EncryptedEnvelope | null = null;
let descriptor: BlobDescriptor | null = null;
let torrentPlan: TorrentPlan | null = null;
let signedEvents: SignedNostrEvent[] = [];
let seedSession: StopHandle | null = null;
let downloadSession: StopHandle | null = null;
let uploadController: AbortController | null = null;
let inspectionController: AbortController | null = null;
let lookupController: AbortController | null = null;
let publishController: AbortController | null = null;
let downloadController: AbortController | null = null;
let seedController: AbortController | null = null;
let resolved: ResolvedHybridEvent | null = null;
let downloadTransport: "blossom" | "swarm" | null = null;
let publicationRevision = 0;
let resolutionRevision = 0;
let profileRevision = 0;
let pageSessionEnded = false;
const objectUrls = new Set<string>();
const SAFE_DOWNLOAD_MIME_TYPE = "application/octet-stream";
type SigningMethod = "nip07" | "external";

class SupersededSigningError extends Error {}

interface ExternalSigningRequest {
  readonly template: EventTemplate;
  readonly expectedPubkey: string;
  readonly resolve: (event: SignedNostrEvent) => void;
  readonly reject: (error: Error) => void;
}

let externalSigningRequest: ExternalSigningRequest | null = null;

function profile(): NetworkProfile {
  const selected = document.querySelector<HTMLInputElement>('input[name="network-profile"]:checked');
  return selected?.value === "tor" ? "tor" : "direct";
}

function signingMethod(): SigningMethod {
  const selected = document.querySelector<HTMLInputElement>('input[name="signing-method"]:checked');
  return selected?.value === "external" ? "external" : "nip07";
}

function assertTorReady(): void {
  if (profile() === "tor" && !torConsent.checked) {
    throw new Error("Confirm that the entire browser is configured through Tor before any Tor-only action.");
  }
}

function signer(): SignerPort {
  if (signingMethod() === "external") return externalSigner;
  if (!window.nostr) throw new Error("No NIP-07 signer is available in this browser.");
  return window.nostr;
}

function relays(): string[] {
  const selectedProfile = profile();
  const result = parseEndpointList(relayInput.value, (value) => normaliseRelayUrl(value, selectedProfile));
  if (result.length === 0) throw new Error("Provide at least one Nostr relay.");
  return result;
}

function trackers(): string[] {
  if (profile() === "tor") throw new Error("WebTorrent is disabled in Tor-only mode.");
  const result = parseEndpointList(trackerInput.value, (value) => normaliseTrackerUrl(value));
  if (result.length === 0) throw new Error("Provide at least one WebSocket tracker.");
  return result;
}

function setStatus(target: HTMLOutputElement, message: string, error = false): void {
  target.textContent = message;
  target.classList.toggle("error", error);
}

class PeerCleanupError extends Error {}

async function confirmPeerStopped(session: StopHandle): Promise<void> {
  try {
    await session.stop();
  } catch (error) {
    throw new PeerCleanupError(
      `Peer cleanup could not be confirmed. Close this tab to force browser peer teardown. ${safeDiagnostic(error)}`,
    );
  }
}

function confirmPeerStoppedInBackground(session: StopHandle, target: HTMLOutputElement): void {
  void confirmPeerStopped(session).catch((error) => setStatus(target, safeDiagnostic(error), true));
}

function showFacts(target: HTMLDListElement, entries: ReadonlyArray<readonly [string, string]>): void {
  target.replaceChildren();
  for (const [term, description] of entries) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = description;
    target.append(dt, dd);
  }
}

function clearDownloads(target: HTMLDivElement): void {
  for (const anchor of target.querySelectorAll<HTMLAnchorElement>("a[href^='blob:']")) {
    URL.revokeObjectURL(anchor.href);
    objectUrls.delete(anchor.href);
  }
  target.replaceChildren();
}

function addDownload(target: HTMLDivElement, blob: Blob, fileName: string, label: string): void {
  const anchor = document.createElement("a");
  // Blob URLs inherit this application's origin. Keep even a signed, verified
  // HTML or SVG payload inert if a browser navigates instead of downloading it.
  const inertBlob = new Blob([blob], { type: SAFE_DOWNLOAD_MIME_TYPE });
  const url = URL.createObjectURL(inertBlob);
  objectUrls.add(url);
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener noreferrer";
  anchor.textContent = label;
  anchor.addEventListener("click", () => window.setTimeout(() => {
    URL.revokeObjectURL(url);
    objectUrls.delete(url);
  }, 30_000), { once: true });
  target.append(anchor);
}

function externalSigningLabel(template: EventTemplate): string {
  if (template.kind === 24242) return "Blossom upload authorisation";
  if (template.kind === 1063) return "NIP-94 file event";
  if (template.kind === 2003) return "NIP-35 torrent index";
  return `Nostr kind ${template.kind} event`;
}

function clearExternalSigningPanel(): void {
  externalSigningPanel.hidden = true;
  externalSigningPurpose.textContent = "";
  externalUnsignedEvent.value = "";
  externalSignedEvent.value = "";
  clearDownloads(externalSigningLinks);
}

function abandonExternalSigning(message = "External signing was superseded."): void {
  const pending = externalSigningRequest;
  externalSigningRequest = null;
  clearExternalSigningPanel();
  pending?.reject(new SupersededSigningError(message));
}

function requestExternalSignature(template: EventTemplate): Promise<SignedNostrEvent> {
  if (externalSigningRequest) throw new Error("Finish or cancel the current external signing request first.");
  const expectedPubkey = assertHex64(externalPubkeyInput.value.trim(), "External signer public key");
  const label = externalSigningLabel(template);
  const unsignedJson = `${JSON.stringify(template, null, 2)}\n`;
  externalSigningPurpose.textContent = `${label}. Transfer only this public unsigned event to the signer, then return its complete signed-event JSON.`;
  externalUnsignedEvent.value = unsignedJson;
  externalSignedEvent.value = "";
  acceptExternalSignatureButton.textContent = template.kind === 24242
    ? "Accept signature and continue upload"
    : "Accept exact signature";
  externalSigningPanel.hidden = false;
  clearDownloads(externalSigningLinks);
  addDownload(
    externalSigningLinks,
    new Blob([unsignedJson], { type: "application/json" }),
    `wildbloom-unsigned-${template.kind}.json`,
    `Download unsigned ${template.kind} event`,
  );
  setStatus(
    publishStatus,
    `${label} is waiting for an external signature. Nothing was sent to the signer or the network by Wildbloom.`,
  );
  externalSignedEvent.focus();
  return new Promise((resolve, reject) => {
    externalSigningRequest = { template: structuredClone(template), expectedPubkey, resolve, reject };
  });
}

const externalSigner: SignerPort = {
  async getPublicKey() {
    return assertHex64(externalPubkeyInput.value.trim(), "External signer public key");
  },
  async signEvent(template) {
    return requestExternalSignature(template);
  },
};

function resetPublicationAfterInspection(): void {
  publicationRevision += 1;
  abandonExternalSigning();
  inspectionController?.abort();
  inspectionController = null;
  uploadController?.abort();
  uploadController = null;
  publishController?.abort();
  publishController = null;
  cancelUploadButton.disabled = true;
  descriptor = null;
  torrentPlan = null;
  signedEvents = [];
  seedController?.abort();
  seedController = null;
  if (seedSession) confirmPeerStoppedInBackground(seedSession, publishStatus);
  seedSession = null;
  stopSeedButton.disabled = true;
  uploadConsent.checked = false;
  keySavedConsent.checked = false;
  seedConsent.checked = false;
  publishConsent.checked = false;
  uploadButton.disabled = true;
  seedButton.disabled = true;
  signButton.disabled = true;
  publishButton.disabled = true;
  clearDownloads(publishLinks);
}

function resetInspection(): void {
  inspectionController?.abort();
  inspectionController = null;
  resetPublicationAfterInspection();
  sourceInspected = null;
  inspected = null;
  protectedEnvelope = null;
  recoveryKeyOutput.type = "password";
  toggleRecoveryKey.textContent = "Reveal recovery key";
  recoveryKeyOutput.value = "";
  recoveryKeyPanel.hidden = true;
  clearDownloads(recoveryLinks);
  fileFacts.replaceChildren();
}

function resetResolution(): void {
  resolutionRevision += 1;
  lookupController?.abort();
  lookupController = null;
  resolveButton.disabled = false;
  downloadController?.abort();
  downloadController = null;
  downloadTransport = null;
  cancelDownloadButton.disabled = true;
  if (downloadSession) confirmPeerStoppedInBackground(downloadSession, retrieveStatus);
  downloadSession = null;
  resolved = null;
  swarmConsent.checked = false;
  recoveryKeyInput.value = "";
  recoveryKeyField.hidden = true;
  blossomFetchButton.disabled = true;
  swarmFetchButton.disabled = true;
  resolvedFacts.replaceChildren();
  clearDownloads(retrieveLinks);
}

function updateUploadButton(): void {
  const keyReady = !protectedEnvelope || keySavedConsent.checked;
  uploadButton.disabled = !(uploadConsent.checked && inspected && pubkey && keyReady && !descriptor && !uploadController);
}

function updateRetrievalButtons(): void {
  const busy = downloadController !== null;
  blossomFetchButton.disabled = busy || !resolved;
  swarmFetchButton.disabled = busy || !(profile() === "direct" && swarmConsent.checked && resolved?.magnetUri);
  cancelDownloadButton.disabled = !busy;
}

function updateSigningCopy(): void {
  if (signingMethod() === "external") {
    signEventCopy.textContent = profile() === "tor"
      ? "External signing hands off one exact encrypted NIP-94 event without installing a Tor Browser add-on. The signer still learns the public event and identity."
      : "External signing hands off the exact NIP-94 and NIP-35 event JSON without giving Wildbloom a private key.";
    return;
  }
  signEventCopy.textContent = profile() === "tor"
    ? "NIP-07 signing creates one encrypted NIP-94 file event locally. A Tor Browser add-on can alter its fingerprint."
    : "NIP-07 signing creates a NIP-94 hybrid file event and a NIP-35 torrent index locally.";
}

function applySigningMethod(): void {
  const external = signingMethod() === "external";
  externalSignerIdentity.hidden = !external;
  externalPubkeyInput.disabled = !external;
  connectSignerButton.textContent = external ? "Use external signer public key" : "Connect NIP-07 signer";
  updateSigningCopy();
}

function applyProfile(): void {
  const tor = profile() === "tor";
  torBoundary.hidden = !tor;
  torConsentField.hidden = !tor;
  iceBoundary.hidden = tor;
  trackerField.hidden = tor;
  trackerInput.disabled = tor;
  seedGate.hidden = tor;
  if (tor) {
    trackerInput.value = "";
    seedConsent.checked = false;
    seedButton.disabled = true;
    blossomInput.placeholder = "http://<56-character-v3-address>.onion";
    replicaInput.placeholder = "http://<56-character-v3-address>.onion";
    relayInput.placeholder = "ws://<56-character-v3-address>.onion";
  } else {
    torConsent.checked = false;
    blossomInput.placeholder = "https://cdn.example.com";
    replicaInput.placeholder = "https://replica.example.com";
    relayInput.placeholder = "wss://relay.example.com";
  }
  updateSigningCopy();
  uploadConsentCopy.textContent = protectFile.checked
    ? "I understand this sends encrypted bytes and visible transfer metadata to the chosen Blossom server."
    : "I understand this sends the plaintext file, filename and MIME type to the chosen Blossom server.";
}

function guard(target: HTMLOutputElement, action: () => Promise<void>): void {
  void action().catch((error) => {
    if (!(error instanceof SupersededSigningError)) setStatus(target, safeDiagnostic(error), true);
  });
}

toggleRecoveryKey.addEventListener("click", () => {
  const reveal = recoveryKeyOutput.type === "password";
  recoveryKeyOutput.type = reveal ? "text" : "password";
  toggleRecoveryKey.textContent = reveal ? "Hide recovery key" : "Reveal recovery key";
});

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="network-profile"]')) {
  input.addEventListener("change", () => {
    profileRevision += 1;
    resetPublicationAfterInspection();
    resetResolution();
    pubkey = null;
    externalPubkeyInput.value = "";
    signerStatus.textContent = "Signer not connected for this network profile";
    blossomInput.value = "";
    replicaInput.value = "";
    relayInput.value = "";
    trackerInput.value = "";
    applyProfile();
    setStatus(publishStatus, "Network profile changed. Re-enter endpoints and repeat every network consent.");
  });
}

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="signing-method"]')) {
  input.addEventListener("change", () => {
    resetPublicationAfterInspection();
    pubkey = null;
    externalPubkeyInput.value = "";
    signerStatus.textContent = "Signer not connected";
    applySigningMethod();
    setStatus(publishStatus, "Signing method changed. Reconnect the signer and repeat every network consent.");
  });
}

externalPubkeyInput.addEventListener("input", () => {
  if (pubkey === null && !descriptor && !externalSigningRequest) return;
  resetPublicationAfterInspection();
  pubkey = null;
  signerStatus.textContent = "External signer public key not confirmed";
  setStatus(publishStatus, "External signer public key changed. Confirm it again before any upload authority is requested.");
});

torConsent.addEventListener("change", () => {
  if (torConsent.checked || profile() !== "tor") return;
  profileRevision += 1;
  pubkey = null;
  externalPubkeyInput.value = "";
  signerStatus.textContent = "Signer not connected for this network profile";
  resetPublicationAfterInspection();
  resetResolution();
  setStatus(publishStatus, "Tor confirmation withdrawn. Active work was cancelled and every network consent was cleared.");
  setStatus(retrieveStatus, "Tor confirmation withdrawn. Resolve the signed event again before downloading.");
});

fileInput.addEventListener("change", () => {
  resetInspection();
  setStatus(publishStatus, "File selection changed. Inspect locally before enabling any network action.");
});

for (const input of [blossomInput, relayInput, trackerInput, replicaInput]) {
  input.addEventListener("input", () => {
    resetPublicationAfterInspection();
    resetResolution();
    setStatus(publishStatus, "Network endpoints changed. Repeat every network consent before publishing.");
    setStatus(retrieveStatus, "Network endpoints changed. Resolve the signed event again before downloading.");
  });
}

eventIdInput.addEventListener("input", () => {
  resetResolution();
  setStatus(retrieveStatus, "Event ID changed. Resolve the signed event again before downloading.");
});

protectFile.addEventListener("change", () => {
  resetInspection();
  applyProfile();
  setStatus(publishStatus, "Protection choice changed. Inspect the file again before any network action.");
});

acceptExternalSignatureButton.addEventListener("click", () => guard(publishStatus, async () => {
  const pending = externalSigningRequest;
  if (!pending) throw new Error("There is no external signing request to complete.");
  let signed: SignedNostrEvent;
  try {
    signed = parseSignedEventJson(pending.template, externalSignedEvent.value, pending.expectedPubkey);
  } catch (error) {
    externalSignedEvent.focus();
    throw error;
  }
  externalSigningRequest = null;
  clearExternalSigningPanel();
  pending.resolve(signed);
  if (pending.template.kind === 24242) cancelUploadButton.focus();
  else signButton.focus();
}));

cancelExternalSignatureButton.addEventListener("click", () => {
  if (!externalSigningRequest) return;
  uploadController?.abort();
  abandonExternalSigning("External signing was cancelled.");
  setStatus(publishStatus, "External signing cancelled. Nothing was signed or sent by Wildbloom.");
});

connectSignerButton.addEventListener("click", () => guard(publishStatus, async () => {
  assertTorReady();
  const expectedProfileRevision = profileRevision;
  const expectedPublicationRevision = publicationRevision;
  const selectedSigningMethod = signingMethod();
  const selectedSigner = signer();
  const candidate = assertHex64(await selectedSigner.getPublicKey(), "Signer public key");
  if (profileRevision !== expectedProfileRevision
    || publicationRevision !== expectedPublicationRevision
    || signingMethod() !== selectedSigningMethod) return;
  pubkey = candidate;
  signerStatus.textContent = candidate;
  updateUploadButton();
  if (signingMethod() === "external") {
    setStatus(
      publishStatus,
      "External signer public key confirmed. Wildbloom will show unsigned JSON for manual transfer; it will not contact the signer.",
    );
  } else {
    setStatus(publishStatus, profile() === "tor"
      ? "Signer connected. A Tor Browser add-on can still alter your fingerprint; nothing has been signed or published."
      : "Signer connected. No event has been signed or published.");
  }
}));

element<HTMLButtonElement>("inspect-file").addEventListener("click", () => guard(publishStatus, async () => {
  const file = fileInput.files?.[0];
  if (!file) throw new Error("Choose a file first.");
  resetInspection();
  const controller = new AbortController();
  inspectionController = controller;
  const expectedRevision = publicationRevision;
  setStatus(publishStatus, "Hashing the source locally…");
  try {
    const nextSource = await inspectFile(file, "source", controller.signal);
    let nextEnvelope: EncryptedEnvelope | null = null;
    let nextInspected = nextSource;
    if (protectFile.checked) {
      setStatus(publishStatus, "Encrypting and padding locally. No bytes have left this browser…");
      nextEnvelope = await encryptPrivacyEnvelope(file, controller.signal);
      nextInspected = await inspectFile(nextEnvelope.file, "transfer", controller.signal);
    }
    if (controller.signal.aborted
      || inspectionController !== controller
      || publicationRevision !== expectedRevision
      || fileInput.files?.[0] !== file) return;

    sourceInspected = nextSource;
    protectedEnvelope = nextEnvelope;
    inspected = nextInspected;
    if (nextEnvelope) {
      recoveryKeyOutput.value = nextEnvelope.recoveryKey;
      recoveryKeyPanel.hidden = false;
      const keyDocument = new Blob([
        "WILDBLOOM RECOVERY KEY: KEEP SECRET\n",
        `${nextEnvelope.recoveryKey}\n\n`,
        "Wildbloom cannot recover this key. Send it separately from the public Nostr event.\n",
      ], { type: "text/plain" });
      addDownload(recoveryLinks, keyDocument, "wildbloom-recovery-key.txt", "Download recovery key");
      showFacts(fileFacts, [
        ["Source name", nextSource.name],
        ["Source bytes", String(nextSource.size)],
        ["Source SHA-256", nextSource.sha256],
        ["Public payload", nextInspected.name],
        ["Public bytes", String(nextInspected.size)],
        ["Public SHA-256", nextInspected.sha256],
        ["Protection", nextEnvelope.scheme],
      ]);
    } else {
      showFacts(fileFacts, [
        ["Name", nextInspected.name],
        ["Bytes", String(nextInspected.size)],
        ["MIME", nextInspected.type],
        ["SHA-256", nextInspected.sha256],
        ["Protection", "None - plaintext metadata and content will be public"],
      ]);
    }
    applyProfile();
    updateUploadButton();
    setStatus(publishStatus, nextEnvelope
      ? "Encrypted transfer payload prepared locally. Save the recovery key before enabling upload."
      : "Plaintext inspection complete. No bytes have left this browser.");
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    if (inspectionController === controller) inspectionController = null;
  }
}));

uploadConsent.addEventListener("change", () => {
  if (!uploadConsent.checked) {
    uploadController?.abort();
    abandonExternalSigning("Upload consent was withdrawn.");
  }
  updateUploadButton();
});
keySavedConsent.addEventListener("change", () => {
  if (!keySavedConsent.checked) {
    uploadController?.abort();
    abandonExternalSigning("Recovery-key acknowledgement was withdrawn.");
  }
  updateUploadButton();
});

uploadButton.addEventListener("click", () => guard(publishStatus, async () => {
  if (!inspected || !pubkey || !uploadConsent.checked) throw new Error("Prepare the file, connect a signer and acknowledge the upload first.");
  if (protectedEnvelope && !keySavedConsent.checked) throw new Error("Save and acknowledge the recovery key before upload.");
  assertTorReady();
  if (uploadController) throw new Error("An upload is already in progress.");
  const expectedRevision = publicationRevision;
  const selectedInspected = inspected;
  const selectedPubkey = pubkey;
  const selectedProfile = profile();
  const selectedSigningMethod = signingMethod();
  const selectedSigner = signer();
  const server = normaliseBlossomServer(blossomInput.value, selectedProfile);
  const selectedTrackers = selectedProfile === "direct" ? trackers() : [];
  const controller = new AbortController();
  uploadController = controller;
  updateUploadButton();
  cancelUploadButton.disabled = false;
  try {
    setStatus(publishStatus, "Requesting a short-lived, server-and-hash-scoped upload signature…");
    const nextDescriptor = await uploadToBlossom(selectedInspected, server, selectedSigner, selectedPubkey, {
      fetchImpl: fetch,
      profile: selectedProfile,
      signal: controller.signal,
      ...(selectedSigningMethod === "external" ? { authorisationLifetimeSeconds: 300 } : {}),
    });
    if (controller.signal.aborted || publicationRevision !== expectedRevision || inspected !== selectedInspected) return;
    let nextTorrentPlan: TorrentPlan | null = null;
    if (selectedProfile === "direct") {
      setStatus(publishStatus, "Blossom accepted the exact payload. Building torrent metadata locally…");
      nextTorrentPlan = await createHybridTorrent(selectedInspected, nextDescriptor.url, selectedTrackers);
    }
    if (controller.signal.aborted || publicationRevision !== expectedRevision || inspected !== selectedInspected) return;
    descriptor = nextDescriptor;
    torrentPlan = nextTorrentPlan;
    const facts: Array<readonly [string, string]> = [
      ["Public payload", selectedInspected.name],
      ["Public bytes", String(selectedInspected.size)],
      ["Public SHA-256", selectedInspected.sha256],
      ["Blossom", nextDescriptor.url],
      ["Blossom URI", buildBlossomUri(selectedInspected, server, selectedPubkey, selectedProfile)],
    ];
    if (nextTorrentPlan) facts.push(["Info hash", nextTorrentPlan.infoHash], ["Magnet", nextTorrentPlan.magnetUri]);
    showFacts(fileFacts, facts);
    clearDownloads(publishLinks);
    if (nextTorrentPlan) {
      addDownload(publishLinks, nextTorrentPlan.torrentBlob, `${selectedInspected.name}.torrent`, "Download .torrent metadata");
      seedButton.disabled = !seedConsent.checked;
    }
    signButton.disabled = false;
    setStatus(publishStatus, torrentPlan
      ? "Encrypted hybrid metadata is staged. Nothing has been seeded or published to Nostr."
      : "Tor-only Blossom metadata is staged. No clearnet fallback or torrent metadata was created.");
  } catch (error) {
    if (!(controller.signal.aborted && publicationRevision !== expectedRevision)) throw error;
  } finally {
    if (uploadController === controller) {
      uploadController = null;
      cancelUploadButton.disabled = true;
      updateUploadButton();
    }
  }
}));

cancelUploadButton.addEventListener("click", () => {
  if (!uploadController) return;
  uploadController.abort();
  abandonExternalSigning("The Blossom upload was cancelled.");
  cancelUploadButton.disabled = true;
  setStatus(publishStatus, "Cancelling the Blossom upload…");
});

seedConsent.addEventListener("change", () => {
  if (!seedConsent.checked) {
    seedController?.abort();
    seedController = null;
    if (seedSession) {
      const session = seedSession;
      seedSession = null;
      confirmPeerStoppedInBackground(session, publishStatus);
    }
    stopSeedButton.disabled = true;
  }
  seedButton.disabled = !(seedConsent.checked && inspected && torrentPlan && !seedSession && !seedController && profile() === "direct");
});

seedButton.addEventListener("click", () => guard(publishStatus, async () => {
  if (!inspected || !torrentPlan || !seedConsent.checked) throw new Error("Build the torrent and acknowledge swarm visibility first.");
  if (seedController) throw new Error("WebTorrent is already starting.");
  const controller = new AbortController();
  seedController = controller;
  setStatus(publishStatus, "Joining the WebTorrent swarm…");
  seedButton.disabled = true;
  stopSeedButton.disabled = false;
  try {
    seedSession = await startBrowserSeeding(inspected, torrentPlan, profile(), undefined, controller.signal);
    if (seedController === controller) seedController = null;
    stopSeedButton.disabled = false;
    setStatus(publishStatus, `Seeding ${torrentPlan.infoHash}. Keep this tab open to remain a peer.`);
  } catch (error) {
    if (seedController === controller) seedController = null;
    stopSeedButton.disabled = true;
    seedButton.disabled = !(seedConsent.checked && inspected && torrentPlan && profile() === "direct");
    throw error;
  }
}));

stopSeedButton.addEventListener("click", () => guard(publishStatus, async () => {
  if (seedController) {
    seedController.abort();
    stopSeedButton.disabled = true;
    setStatus(publishStatus, "Cancelling WebTorrent startup…");
    return;
  }
  if (!seedSession) return;
  const session = seedSession;
  seedSession = null;
  stopSeedButton.disabled = true;
  await confirmPeerStopped(session);
  seedButton.disabled = !(seedConsent.checked && inspected && torrentPlan && profile() === "direct");
  setStatus(publishStatus, "Peer seeding stopped. Blossom and published relay events are unchanged.");
}));

signButton.addEventListener("click", () => guard(publishStatus, async () => {
  if (!inspected || !descriptor || !pubkey) throw new Error("Complete the Blossom stage first.");
  assertTorReady();
  const expectedRevision = publicationRevision;
  const selectedInspected = inspected;
  const selectedDescriptor = descriptor;
  const selectedTorrentPlan = torrentPlan;
  const selectedPubkey = pubkey;
  const selectedProfile = profile();
  const selectedSigningMethod = signingMethod();
  const selectedSigner = signer();
  const publication: HybridPublication = {
    inspected: selectedInspected,
    descriptor: selectedDescriptor,
    ...(selectedTorrentPlan ? { torrent: selectedTorrentPlan } : {}),
    ...(protectedEnvelope ? { encryption: protectedEnvelope.scheme } : {}),
  };
  const fileEvent = await signEventExactly(buildFileEvent(publication), selectedSigner, selectedPubkey);
  if (publicationRevision !== expectedRevision || profile() !== selectedProfile) return;
  const nextSignedEvents = [fileEvent];
  if (selectedTorrentPlan) {
    const torrentEvent = await signEventExactly(
      buildTorrentEvent(selectedInspected, selectedTorrentPlan),
      selectedSigner,
      selectedPubkey,
    );
    if (publicationRevision !== expectedRevision || profile() !== selectedProfile) return;
    nextSignedEvents.push(torrentEvent);
  }
  signedEvents = nextSignedEvents;
  publishButton.disabled = !publishConsent.checked;
  const identifiers = signedEvents.map((event) => `${event.kind}: ${event.id}`).join("\n");
  setStatus(
    publishStatus,
    `${selectedSigningMethod === "external" ? "Exact external signatures accepted" : "Signed locally through NIP-07"}.\n${identifiers}\nNo relay publication yet.`,
  );
}));

publishConsent.addEventListener("change", () => {
  if (!publishConsent.checked) publishController?.abort();
  publishButton.disabled = !(publishConsent.checked && signedEvents.length > 0);
});

publishButton.addEventListener("click", () => guard(publishStatus, async () => {
  if (!publishConsent.checked || signedEvents.length === 0) throw new Error("Review, sign and acknowledge public relay publication first.");
  assertTorReady();
  if (publishController) throw new Error("Relay publication is already in progress.");
  const expectedRevision = publicationRevision;
  const selectedProfile = profile();
  const targets = relays();
  const events = [...signedEvents];
  const controller = new AbortController();
  publishController = controller;
  publishButton.disabled = true;
  const lines: string[] = [];
  try {
    for (const event of events) {
      const results = await publishToRelays(targets, event, selectedProfile, controller.signal);
      if (controller.signal.aborted || publicationRevision !== expectedRevision || profile() !== selectedProfile) return;
      for (const result of results) lines.push(`${event.kind} ${result.relay}: ${result.ok ? "accepted" : "failed"} - ${result.message}`);
    }
    const accepted = lines.filter((line) => line.includes(": accepted -")).length;
    setStatus(publishStatus, `Relay publication finished (${accepted}/${lines.length} acknowledgements).\n${lines.join("\n")}`, accepted === 0);
  } finally {
    if (publishController === controller) publishController = null;
  }
}));

resolveButton.addEventListener("click", () => guard(retrieveStatus, async () => {
  assertTorReady();
  const eventId = assertHex64(eventIdInput.value.trim(), "Event ID");
  const selectedProfile = profile();
  const targets = relays();
  resetResolution();
  const controller = new AbortController();
  lookupController = controller;
  const expectedRevision = resolutionRevision;
  resolveButton.disabled = true;
  setStatus(retrieveStatus, "Querying the chosen relays and verifying the returned signature…");
  try {
    const nextResolved = await resolveFromRelays(targets, eventId, selectedProfile, controller.signal);
    if (controller.signal.aborted
      || lookupController !== controller
      || resolutionRevision !== expectedRevision
      || profile() !== selectedProfile
      || eventIdInput.value.trim().toLowerCase() !== eventId) return;
    resolved = nextResolved;
    showFacts(resolvedFacts, [
      ["Author", nextResolved.event.pubkey],
      ["Public name", nextResolved.name],
      ["Public bytes", String(nextResolved.size)],
      ["SHA-256", nextResolved.sha256],
      ["Blossom", nextResolved.url],
      ["Protection", nextResolved.encryption ?? "None"],
      ["Info hash", nextResolved.infoHash ?? "Not advertised"],
    ]);
    recoveryKeyField.hidden = !nextResolved.encryption;
    updateRetrievalButtons();
    setStatus(retrieveStatus, nextResolved.encryption
      ? "Signed event verified. Enter the separately received recovery key when downloading."
      : "Signed event verified. The advertised payload is plaintext; no file has been downloaded.");
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    if (lookupController === controller) {
      lookupController = null;
      resolveButton.disabled = false;
    }
  }
}));

async function revealPayload(blob: Blob, event: ResolvedHybridEvent, signal: AbortSignal): Promise<File | Blob> {
  if (!event.encryption) return blob;
  const key = recoveryKeyInput.value.trim();
  if (!key) throw new Error("Enter the separately received recovery key.");
  const decrypted = await decryptPrivacyEnvelope(blob, key, signal);
  if (signal.aborted) throw new Error("Local decryption cancelled.");
  recoveryKeyInput.value = "";
  return decrypted;
}

blossomFetchButton.addEventListener("click", () => guard(retrieveStatus, async () => {
  if (!resolved) throw new Error("Resolve a signed event first.");
  assertTorReady();
  if (downloadController) throw new Error("A download is already in progress.");
  const selectedResolved = resolved;
  const selectedProfile = profile();
  const selectedReplica = replicaInput.value.trim();
  const expectedRevision = resolutionRevision;
  const controller = new AbortController();
  downloadController = controller;
  downloadTransport = "blossom";
  updateRetrievalButtons();
  clearDownloads(retrieveLinks);
  try {
    setStatus(retrieveStatus, "Downloading from Blossom and verifying signed size and SHA-256…");
    const verified = await fetchVerifiedBlob(selectedResolved, {
      fetchImpl: fetch,
      profile: selectedProfile,
      signal: controller.signal,
      replicaServer: selectedReplica,
    });
    const payload = await revealPayload(verified, selectedResolved, controller.signal);
    if (controller.signal.aborted
      || resolutionRevision !== expectedRevision
      || resolved !== selectedResolved
      || profile() !== selectedProfile) return;
    const downloadName = payload instanceof File ? payload.name : selectedResolved.name;
    addDownload(retrieveLinks, payload, downloadName, `Save verified ${downloadName}`);
    setStatus(retrieveStatus, selectedResolved.encryption
      ? "Ciphertext and AES-GCM authentication verified. The save link points to locally decrypted bytes."
      : "Blossom download verified. The save link points to the checked local bytes.");
  } catch (error) {
    if (!(controller.signal.aborted && resolutionRevision !== expectedRevision)) throw error;
  } finally {
    if (downloadController === controller) {
      downloadController = null;
      downloadTransport = null;
    }
    updateRetrievalButtons();
  }
}));

swarmConsent.addEventListener("change", () => {
  if (!swarmConsent.checked) {
    if (downloadTransport === "swarm") {
      setStatus(retrieveStatus, "Leaving the WebTorrent swarm…");
      downloadController?.abort();
    }
    if (downloadSession) {
      const session = downloadSession;
      const expectedRevision = resolutionRevision;
      downloadSession = null;
      setStatus(retrieveStatus, "Leaving the WebTorrent swarm…");
      void confirmPeerStopped(session).then(
        () => {
          if (resolutionRevision === expectedRevision && !swarmConsent.checked) {
            setStatus(retrieveStatus, "Swarm participation stopped. Previously received local bytes are unchanged.");
          }
        },
        (error) => setStatus(retrieveStatus, safeDiagnostic(error), true),
      );
    }
  }
  updateRetrievalButtons();
});

swarmFetchButton.addEventListener("click", () => guard(retrieveStatus, async () => {
  if (!resolved || !resolved.magnetUri || !swarmConsent.checked) throw new Error("Resolve a torrent event and acknowledge swarm visibility first.");
  if (downloadController) throw new Error("A download is already in progress.");
  if (downloadSession) {
    const previousSession = downloadSession;
    downloadSession = null;
    await confirmPeerStopped(previousSession);
  }
  const selectedResolved = resolved;
  const selectedProfile = profile();
  const expectedRevision = resolutionRevision;
  const controller = new AbortController();
  downloadController = controller;
  downloadTransport = "swarm";
  updateRetrievalButtons();
  clearDownloads(retrieveLinks);
  let provisionalSession: StopHandle | null = null;
  let cleanupError: unknown;
  try {
    setStatus(retrieveStatus, "Joining the swarm. Waiting for verified bytes…");
    const result = await downloadFromSwarm(selectedResolved, (progress, speed) => {
      if (!controller.signal.aborted && resolutionRevision === expectedRevision && resolved === selectedResolved) {
        setStatus(retrieveStatus, `Swarm download ${(progress * 100).toFixed(1)}% · ${(speed / 1024).toFixed(1)} KiB/s`);
      }
    }, selectedProfile, undefined, controller.signal);
    provisionalSession = result.session;
    if (controller.signal.aborted
      || resolutionRevision !== expectedRevision
      || resolved !== selectedResolved
      || profile() !== selectedProfile) return;
    const payload = await revealPayload(result.blob, selectedResolved, controller.signal);
    if (controller.signal.aborted
      || resolutionRevision !== expectedRevision
      || resolved !== selectedResolved
      || profile() !== selectedProfile) return;
    const downloadName = payload instanceof File ? payload.name : selectedResolved.name;
    addDownload(retrieveLinks, payload, downloadName, `Save verified ${downloadName}`);
    downloadSession = result.session;
    provisionalSession = null;
    setStatus(retrieveStatus, selectedResolved.encryption
      ? "Swarm ciphertext, SHA-256 and AES-GCM authentication verified."
      : "Swarm download verified against the signed SHA-256.");
  } catch (error) {
    if (error instanceof PeerCleanupError
      || !(controller.signal.aborted && (resolutionRevision !== expectedRevision || !swarmConsent.checked))) throw error;
  } finally {
    if (provisionalSession) {
      try {
        await confirmPeerStopped(provisionalSession);
      } catch (error) {
        cleanupError = error;
      }
    }
    if (downloadController === controller) {
      downloadController = null;
      downloadTransport = null;
    }
    if (cleanupError) swarmConsent.checked = false;
    updateRetrievalButtons();
    if (!cleanupError && controller.signal.aborted && !swarmConsent.checked
      && resolutionRevision === expectedRevision) {
      setStatus(retrieveStatus, "Swarm participation stopped. No peer session was retained.");
    }
    if (cleanupError) throw cleanupError;
  }
}));

cancelDownloadButton.addEventListener("click", () => {
  if (!downloadController) return;
  downloadController.abort();
  cancelDownloadButton.disabled = true;
  setStatus(retrieveStatus, "Cancelling the active download…");
});

function endPageSession(): void {
  if (pageSessionEnded) return;
  pageSessionEnded = true;
  profileRevision += 1;
  const peerSessions = [seedSession, downloadSession].filter((session): session is StopHandle => session !== null);
  seedSession = null;
  downloadSession = null;
  resetInspection();
  resetResolution();
  pubkey = null;
  fileInput.value = "";
  blossomInput.value = "";
  replicaInput.value = "";
  relayInput.value = "";
  trackerInput.value = "";
  eventIdInput.value = "";
  externalPubkeyInput.value = "";
  torConsent.checked = false;
  signerStatus.textContent = "Signer not connected; the previous page session ended";
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
  applyProfile();
  applySigningMethod();
  setStatus(publishStatus, "Previous page session cleared during navigation. Re-enter the file, endpoints and signer to begin again.");
  setStatus(retrieveStatus, "Previous page session cleared during navigation. Resolve the signed event again to begin a new retrieval.");
  for (const session of peerSessions) void session.stop().catch(() => undefined);
}

window.addEventListener("pagehide", endPageSession);
window.addEventListener("pageshow", (event) => {
  // A restored page would otherwise keep the old JavaScript heap. Recreate the
  // document after clearing it so a BFCache return always starts a new session.
  if (event.persisted) window.location.reload();
});

applyProfile();
applySigningMethod();
