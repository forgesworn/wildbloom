import "./style.css";
import { buildBlossomUri, fetchVerifiedBlob, inspectFile, uploadToBlossom } from "./core/blossom.js";
import { decryptPrivacyEnvelope, encryptPrivacyEnvelope, type EncryptedEnvelope } from "./core/crypto.js";
import { buildFileEvent, buildTorrentEvent, signEventExactly } from "./core/nostr.js";
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
const signerStatus = element<HTMLOutputElement>("signer-status");
const publishStatus = element<HTMLOutputElement>("publish-status");
const retrieveStatus = element<HTMLOutputElement>("retrieve-status");
const fileInput = element<HTMLInputElement>("publish-file");
const protectFile = element<HTMLInputElement>("protect-file");
const eventIdInput = element<HTMLInputElement>("event-id");
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
const seedButton = element<HTMLButtonElement>("start-seeding");
const signButton = element<HTMLButtonElement>("sign-events");
const publishButton = element<HTMLButtonElement>("publish-events");
const blossomFetchButton = element<HTMLButtonElement>("fetch-blossom");
const swarmFetchButton = element<HTMLButtonElement>("fetch-swarm");

let pubkey: string | null = null;
let sourceInspected: InspectedFile | null = null;
let inspected: InspectedFile | null = null;
let protectedEnvelope: EncryptedEnvelope | null = null;
let descriptor: BlobDescriptor | null = null;
let torrentPlan: TorrentPlan | null = null;
let signedEvents: SignedNostrEvent[] = [];
let seedSession: StopHandle | null = null;
let downloadSession: StopHandle | null = null;
let resolved: ResolvedHybridEvent | null = null;
const objectUrls = new Set<string>();

function profile(): NetworkProfile {
  const selected = document.querySelector<HTMLInputElement>('input[name="network-profile"]:checked');
  return selected?.value === "tor" ? "tor" : "direct";
}

function assertTorReady(): void {
  if (profile() === "tor" && !torConsent.checked) {
    throw new Error("Confirm that the entire browser is configured through Tor before any Tor-only action.");
  }
}

function signer(): SignerPort {
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
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  anchor.href = url;
  anchor.download = fileName;
  anchor.textContent = label;
  anchor.addEventListener("click", () => window.setTimeout(() => {
    URL.revokeObjectURL(url);
    objectUrls.delete(url);
  }, 30_000), { once: true });
  target.append(anchor);
}

function resetPublicationAfterInspection(): void {
  descriptor = null;
  torrentPlan = null;
  signedEvents = [];
  if (seedSession) void seedSession.stop();
  seedSession = null;
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
  uploadButton.disabled = !(uploadConsent.checked && inspected && pubkey && keyReady);
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
    relayInput.placeholder = "ws://<56-character-v3-address>.onion";
    signEventCopy.textContent = "Signing creates one encrypted NIP-94 file event locally. Torrent metadata is omitted in Tor-only mode.";
  } else {
    torConsent.checked = false;
    blossomInput.placeholder = "https://cdn.example.com";
    relayInput.placeholder = "wss://relay.example.com";
    signEventCopy.textContent = "Signing creates a NIP-94 hybrid file event and a NIP-35 torrent index locally.";
  }
  uploadConsentCopy.textContent = protectFile.checked
    ? "I understand this sends encrypted bytes and visible transfer metadata to the chosen Blossom server."
    : "I understand this sends the plaintext file, filename and MIME type to the chosen Blossom server.";
}

function guard(target: HTMLOutputElement, action: () => Promise<void>): void {
  void action().catch((error) => setStatus(target, safeDiagnostic(error), true));
}

toggleRecoveryKey.addEventListener("click", () => {
  const reveal = recoveryKeyOutput.type === "password";
  recoveryKeyOutput.type = reveal ? "text" : "password";
  toggleRecoveryKey.textContent = reveal ? "Hide recovery key" : "Reveal recovery key";
});

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="network-profile"]')) {
  input.addEventListener("change", () => {
    resetPublicationAfterInspection();
    resetResolution();
    blossomInput.value = "";
    relayInput.value = "";
    trackerInput.value = "";
    applyProfile();
    setStatus(publishStatus, "Network profile changed. Re-enter endpoints and repeat every network consent.");
  });
}

fileInput.addEventListener("change", () => {
  resetInspection();
  setStatus(publishStatus, "File selection changed. Inspect locally before enabling any network action.");
});

protectFile.addEventListener("change", () => {
  resetInspection();
  applyProfile();
  setStatus(publishStatus, "Protection choice changed. Inspect the file again before any network action.");
});

element<HTMLButtonElement>("connect-signer").addEventListener("click", () => guard(publishStatus, async () => {
  assertTorReady();
  pubkey = assertHex64(await signer().getPublicKey(), "Signer public key");
  signerStatus.textContent = pubkey;
  updateUploadButton();
  setStatus(publishStatus, profile() === "tor"
    ? "Signer connected. A Tor Browser add-on can still alter your fingerprint; nothing has been signed or published."
    : "Signer connected. No event has been signed or published.");
}));

element<HTMLButtonElement>("inspect-file").addEventListener("click", () => guard(publishStatus, async () => {
  const file = fileInput.files?.[0];
  if (!file) throw new Error("Choose a file first.");
  resetInspection();
  setStatus(publishStatus, "Hashing the source locally…");
  sourceInspected = await inspectFile(file);
  if (protectFile.checked) {
    setStatus(publishStatus, "Encrypting and padding locally. No bytes have left this browser…");
    protectedEnvelope = await encryptPrivacyEnvelope(file);
    inspected = await inspectFile(protectedEnvelope.file, "transfer");
    recoveryKeyOutput.value = protectedEnvelope.recoveryKey;
    recoveryKeyPanel.hidden = false;
    const keyDocument = new Blob([
      "WILDBLOOM RECOVERY KEY: KEEP SECRET\n",
      `${protectedEnvelope.recoveryKey}\n\n`,
      "Wildbloom cannot recover this key. Send it separately from the public Nostr event.\n",
    ], { type: "text/plain" });
    addDownload(recoveryLinks, keyDocument, "wildbloom-recovery-key.txt", "Download recovery key");
    showFacts(fileFacts, [
      ["Source name", sourceInspected.name],
      ["Source bytes", String(sourceInspected.size)],
      ["Source SHA-256", sourceInspected.sha256],
      ["Public payload", inspected.name],
      ["Public bytes", String(inspected.size)],
      ["Public SHA-256", inspected.sha256],
      ["Protection", protectedEnvelope.scheme],
    ]);
  } else {
    inspected = sourceInspected;
    showFacts(fileFacts, [
      ["Name", inspected.name],
      ["Bytes", String(inspected.size)],
      ["MIME", inspected.type],
      ["SHA-256", inspected.sha256],
      ["Protection", "None - plaintext metadata and content will be public"],
    ]);
  }
  applyProfile();
  updateUploadButton();
  setStatus(publishStatus, protectedEnvelope
    ? "Encrypted transfer payload prepared locally. Save the recovery key before enabling upload."
    : "Plaintext inspection complete. No bytes have left this browser.");
}));

uploadConsent.addEventListener("change", updateUploadButton);
keySavedConsent.addEventListener("change", updateUploadButton);

uploadButton.addEventListener("click", () => guard(publishStatus, async () => {
  if (!inspected || !pubkey || !uploadConsent.checked) throw new Error("Prepare the file, connect a signer and acknowledge the upload first.");
  if (protectedEnvelope && !keySavedConsent.checked) throw new Error("Save and acknowledge the recovery key before upload.");
  assertTorReady();
  const selectedProfile = profile();
  const server = normaliseBlossomServer(blossomInput.value, selectedProfile);
  setStatus(publishStatus, "Requesting a short-lived, server-and-hash-scoped upload signature…");
  descriptor = await uploadToBlossom(inspected, server, signer(), pubkey, fetch, selectedProfile);
  if (selectedProfile === "direct") {
    setStatus(publishStatus, "Blossom accepted the exact payload. Building torrent metadata locally…");
    torrentPlan = await createHybridTorrent(inspected, descriptor.url, trackers());
  } else {
    torrentPlan = null;
  }
  const facts: Array<readonly [string, string]> = [
    ["Public payload", inspected.name],
    ["Public bytes", String(inspected.size)],
    ["Public SHA-256", inspected.sha256],
    ["Blossom", descriptor.url],
    ["Blossom URI", buildBlossomUri(inspected, server, pubkey, selectedProfile)],
  ];
  if (torrentPlan) facts.push(["Info hash", torrentPlan.infoHash], ["Magnet", torrentPlan.magnetUri]);
  showFacts(fileFacts, facts);
  clearDownloads(publishLinks);
  if (torrentPlan) {
    addDownload(publishLinks, torrentPlan.torrentBlob, `${inspected.name}.torrent`, "Download .torrent metadata");
    seedButton.disabled = !seedConsent.checked;
  }
  signButton.disabled = false;
  setStatus(publishStatus, torrentPlan
    ? "Encrypted hybrid metadata is staged. Nothing has been seeded or published to Nostr."
    : "Tor-only Blossom metadata is staged. No clearnet fallback or torrent metadata was created.");
}));

seedConsent.addEventListener("change", () => {
  seedButton.disabled = !(seedConsent.checked && inspected && torrentPlan && !seedSession && profile() === "direct");
});

seedButton.addEventListener("click", () => guard(publishStatus, async () => {
  if (!inspected || !torrentPlan || !seedConsent.checked) throw new Error("Build the torrent and acknowledge swarm visibility first.");
  setStatus(publishStatus, "Joining the WebTorrent swarm…");
  seedSession = await startBrowserSeeding(inspected, torrentPlan, profile());
  seedButton.disabled = true;
  setStatus(publishStatus, `Seeding ${torrentPlan.infoHash}. Keep this tab open to remain a peer.`);
}));

signButton.addEventListener("click", () => guard(publishStatus, async () => {
  if (!inspected || !descriptor || !pubkey) throw new Error("Complete the Blossom stage first.");
  assertTorReady();
  const publication: HybridPublication = {
    inspected,
    descriptor,
    ...(torrentPlan ? { torrent: torrentPlan } : {}),
    ...(protectedEnvelope ? { encryption: protectedEnvelope.scheme } : {}),
  };
  const fileEvent = await signEventExactly(buildFileEvent(publication), signer(), pubkey);
  signedEvents = [fileEvent];
  if (torrentPlan) signedEvents.push(await signEventExactly(buildTorrentEvent(inspected, torrentPlan), signer(), pubkey));
  publishButton.disabled = !publishConsent.checked;
  const identifiers = signedEvents.map((event) => `${event.kind}: ${event.id}`).join("\n");
  setStatus(publishStatus, `Signed locally through NIP-07.\n${identifiers}\nNo relay publication yet.`);
}));

publishConsent.addEventListener("change", () => {
  publishButton.disabled = !(publishConsent.checked && signedEvents.length > 0);
});

publishButton.addEventListener("click", () => guard(publishStatus, async () => {
  if (!publishConsent.checked || signedEvents.length === 0) throw new Error("Review, sign and acknowledge public relay publication first.");
  assertTorReady();
  const selectedProfile = profile();
  const targets = relays();
  const lines: string[] = [];
  for (const event of signedEvents) {
    const results = await publishToRelays(targets, event, selectedProfile);
    for (const result of results) lines.push(`${event.kind} ${result.relay}: ${result.ok ? "accepted" : "failed"} - ${result.message}`);
  }
  publishButton.disabled = true;
  const accepted = lines.filter((line) => line.includes(": accepted -")).length;
  setStatus(publishStatus, `Relay publication finished (${accepted}/${lines.length} acknowledgements).\n${lines.join("\n")}`, accepted === 0);
}));

element<HTMLButtonElement>("resolve-event").addEventListener("click", () => guard(retrieveStatus, async () => {
  assertTorReady();
  const eventId = assertHex64(eventIdInput.value.trim(), "Event ID");
  resetResolution();
  setStatus(retrieveStatus, "Querying the chosen relays and verifying the returned signature…");
  resolved = await resolveFromRelays(relays(), eventId, profile());
  showFacts(resolvedFacts, [
    ["Author", resolved.event.pubkey],
    ["Public name", resolved.name],
    ["Public bytes", String(resolved.size)],
    ["SHA-256", resolved.sha256],
    ["Blossom", resolved.url],
    ["Protection", resolved.encryption ?? "None"],
    ["Info hash", resolved.infoHash ?? "Not advertised"],
  ]);
  recoveryKeyField.hidden = !resolved.encryption;
  blossomFetchButton.disabled = false;
  swarmFetchButton.disabled = !(profile() === "direct" && swarmConsent.checked && resolved.magnetUri);
  setStatus(retrieveStatus, resolved.encryption
    ? "Signed event verified. Enter the separately received recovery key when downloading."
    : "Signed event verified. The advertised payload is plaintext; no file has been downloaded.");
}));

async function revealPayload(blob: Blob, event: ResolvedHybridEvent): Promise<File | Blob> {
  if (!event.encryption) return blob;
  const key = recoveryKeyInput.value.trim();
  if (!key) throw new Error("Enter the separately received recovery key.");
  const decrypted = await decryptPrivacyEnvelope(blob, key);
  recoveryKeyInput.value = "";
  return decrypted;
}

blossomFetchButton.addEventListener("click", () => guard(retrieveStatus, async () => {
  if (!resolved) throw new Error("Resolve a signed event first.");
  assertTorReady();
  setStatus(retrieveStatus, "Downloading from Blossom and verifying signed size and SHA-256…");
  const verified = await fetchVerifiedBlob(resolved, fetch, profile());
  const payload = await revealPayload(verified, resolved);
  clearDownloads(retrieveLinks);
  addDownload(retrieveLinks, payload, payload instanceof File ? payload.name : resolved.name, `Save verified ${payload instanceof File ? payload.name : resolved.name}`);
  setStatus(retrieveStatus, resolved.encryption
    ? "Ciphertext and AES-GCM authentication verified. The save link points to locally decrypted bytes."
    : "Blossom download verified. The save link points to the checked local bytes.");
}));

swarmConsent.addEventListener("change", () => {
  swarmFetchButton.disabled = !(swarmConsent.checked && resolved?.magnetUri && profile() === "direct");
});

swarmFetchButton.addEventListener("click", () => guard(retrieveStatus, async () => {
  if (!resolved || !resolved.magnetUri || !swarmConsent.checked) throw new Error("Resolve a torrent event and acknowledge swarm visibility first.");
  if (downloadSession) await downloadSession.stop();
  setStatus(retrieveStatus, "Joining the swarm. Waiting for verified bytes…");
  const result = await downloadFromSwarm(resolved, (progress, speed) => {
    setStatus(retrieveStatus, `Swarm download ${(progress * 100).toFixed(1)}% · ${(speed / 1024).toFixed(1)} KiB/s`);
  }, profile());
  downloadSession = result.session;
  const payload = await revealPayload(result.blob, resolved);
  clearDownloads(retrieveLinks);
  addDownload(retrieveLinks, payload, payload instanceof File ? payload.name : resolved.name, `Save verified ${payload instanceof File ? payload.name : resolved.name}`);
  setStatus(retrieveStatus, resolved.encryption
    ? "Swarm ciphertext, SHA-256 and AES-GCM authentication verified."
    : "Swarm download verified against the signed SHA-256.");
}));

window.addEventListener("beforeunload", () => {
  if (seedSession) void seedSession.stop();
  if (downloadSession) void downloadSession.stop();
  for (const url of objectUrls) URL.revokeObjectURL(url);
});

applyProfile();
