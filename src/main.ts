import "./style.css";
import { buildBlossomUri, fetchVerifiedBlob, inspectFile, uploadToBlossom } from "./core/blossom.js";
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
const signerStatus = element<HTMLOutputElement>("signer-status");
const publishStatus = element<HTMLOutputElement>("publish-status");
const retrieveStatus = element<HTMLOutputElement>("retrieve-status");
const fileInput = element<HTMLInputElement>("publish-file");
const eventIdInput = element<HTMLInputElement>("event-id");
const fileFacts = element<HTMLDListElement>("file-facts");
const resolvedFacts = element<HTMLDListElement>("resolved-facts");
const publishLinks = element<HTMLDivElement>("publish-links");
const retrieveLinks = element<HTMLDivElement>("retrieve-links");

const uploadConsent = element<HTMLInputElement>("upload-consent");
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
let inspected: InspectedFile | null = null;
let descriptor: BlobDescriptor | null = null;
let torrentPlan: TorrentPlan | null = null;
let signedEvents: SignedNostrEvent[] = [];
let seedSession: StopHandle | null = null;
let downloadSession: StopHandle | null = null;
let resolved: ResolvedHybridEvent | null = null;

function signer(): SignerPort {
  if (!window.nostr) throw new Error("No NIP-07 signer is available in this browser.");
  return window.nostr;
}

function relays(): string[] {
  const result = parseEndpointList(relayInput.value, normaliseRelayUrl);
  if (result.length === 0) throw new Error("Provide at least one Nostr relay.");
  return result;
}

function trackers(): string[] {
  const result = parseEndpointList(trackerInput.value, normaliseTrackerUrl);
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

function addDownload(target: HTMLDivElement, blob: Blob, fileName: string, label: string): void {
  const anchor = document.createElement("a");
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = fileName;
  anchor.textContent = label;
  anchor.addEventListener("click", () => window.setTimeout(() => URL.revokeObjectURL(url), 30_000), { once: true });
  target.append(anchor);
}

function resetPublicationAfterInspection(): void {
  descriptor = null;
  torrentPlan = null;
  signedEvents = [];
  if (seedSession) void seedSession.stop();
  seedSession = null;
  uploadButton.disabled = true;
  seedButton.disabled = true;
  signButton.disabled = true;
  publishButton.disabled = true;
  publishLinks.replaceChildren();
}

function guard(target: HTMLOutputElement, action: () => Promise<void>): void {
  void action().catch((error) => setStatus(target, safeDiagnostic(error), true));
}

element<HTMLButtonElement>("connect-signer").addEventListener("click", () => guard(publishStatus, async () => {
  pubkey = assertHex64(await signer().getPublicKey(), "Signer public key");
  signerStatus.textContent = pubkey;
  if (inspected && uploadConsent.checked) uploadButton.disabled = false;
  setStatus(publishStatus, "Signer connected. No event has been signed or published.");
}));

element<HTMLButtonElement>("inspect-file").addEventListener("click", () => guard(publishStatus, async () => {
  const file = fileInput.files?.[0];
  if (!file) throw new Error("Choose a file first.");
  resetPublicationAfterInspection();
  setStatus(publishStatus, "Hashing locally…");
  inspected = await inspectFile(file);
  showFacts(fileFacts, [
    ["Name", inspected.name],
    ["Bytes", String(inspected.size)],
    ["MIME", inspected.type],
    ["SHA-256", inspected.sha256],
  ]);
  uploadButton.disabled = !(pubkey && uploadConsent.checked);
  setStatus(publishStatus, "Local inspection complete. No bytes have left this browser.");
}));

uploadConsent.addEventListener("change", () => {
  uploadButton.disabled = !(uploadConsent.checked && inspected && pubkey);
});

uploadButton.addEventListener("click", () => guard(publishStatus, async () => {
  if (!inspected || !pubkey || !uploadConsent.checked) throw new Error("Inspect the file, connect a signer and acknowledge the upload first.");
  const server = normaliseBlossomServer(blossomInput.value);
  setStatus(publishStatus, "Requesting a short-lived, server-and-hash-scoped upload signature…");
  descriptor = await uploadToBlossom(inspected, server, signer(), pubkey);
  setStatus(publishStatus, "Blossom accepted the exact bytes. Building torrent metadata locally…");
  torrentPlan = await createHybridTorrent(inspected, descriptor.url, trackers());
  showFacts(fileFacts, [
    ["Name", inspected.name],
    ["Bytes", String(inspected.size)],
    ["SHA-256", inspected.sha256],
    ["Blossom", descriptor.url],
    ["Blossom URI", buildBlossomUri(inspected, server, pubkey)],
    ["Info hash", torrentPlan.infoHash],
    ["Magnet", torrentPlan.magnetUri],
  ]);
  publishLinks.replaceChildren();
  addDownload(publishLinks, torrentPlan.torrentBlob, `${inspected.name}.torrent`, "Download .torrent metadata");
  seedButton.disabled = !seedConsent.checked;
  signButton.disabled = false;
  setStatus(publishStatus, "Hybrid metadata is staged. Nothing has been seeded or published to Nostr.");
}));

seedConsent.addEventListener("change", () => {
  seedButton.disabled = !(seedConsent.checked && inspected && torrentPlan && !seedSession);
});

seedButton.addEventListener("click", () => guard(publishStatus, async () => {
  if (!inspected || !torrentPlan || !seedConsent.checked) throw new Error("Build the torrent and acknowledge swarm visibility first.");
  setStatus(publishStatus, "Joining the WebTorrent swarm…");
  seedSession = await startBrowserSeeding(inspected, torrentPlan);
  seedButton.disabled = true;
  setStatus(publishStatus, `Seeding ${torrentPlan.infoHash}. Keep this tab open to remain a peer.`);
}));

signButton.addEventListener("click", () => guard(publishStatus, async () => {
  if (!inspected || !descriptor || !torrentPlan || !pubkey) throw new Error("Complete the Blossom and torrent stages first.");
  const publication: HybridPublication = { inspected, descriptor, torrent: torrentPlan };
  const fileEvent = await signEventExactly(buildFileEvent(publication), signer(), pubkey);
  const torrentEvent = await signEventExactly(buildTorrentEvent(inspected, torrentPlan), signer(), pubkey);
  signedEvents = [fileEvent, torrentEvent];
  publishButton.disabled = !publishConsent.checked;
  setStatus(publishStatus, `Signed locally through NIP-07.\nNIP-94: ${fileEvent.id}\nNIP-35: ${torrentEvent.id}\nNo relay publication yet.`);
}));

publishConsent.addEventListener("change", () => {
  publishButton.disabled = !(publishConsent.checked && signedEvents.length === 2);
});

publishButton.addEventListener("click", () => guard(publishStatus, async () => {
  if (!publishConsent.checked || signedEvents.length !== 2) throw new Error("Review, sign and acknowledge public relay publication first.");
  const targets = relays();
  const lines: string[] = [];
  for (const event of signedEvents) {
    const results = await publishToRelays(targets, event);
    for (const result of results) lines.push(`${event.kind} ${result.relay}: ${result.ok ? "accepted" : "failed"} — ${result.message}`);
  }
  publishButton.disabled = true;
  const accepted = lines.filter((line) => line.includes(": accepted —")).length;
  setStatus(publishStatus, `Relay publication finished (${accepted}/${lines.length} acknowledgements).\n${lines.join("\n")}`, accepted === 0);
}));

element<HTMLButtonElement>("resolve-event").addEventListener("click", () => guard(retrieveStatus, async () => {
  const eventId = assertHex64(eventIdInput.value.trim(), "Event ID");
  retrieveLinks.replaceChildren();
  setStatus(retrieveStatus, "Querying the chosen relays and verifying the returned signature…");
  resolved = await resolveFromRelays(relays(), eventId);
  showFacts(resolvedFacts, [
    ["Author", resolved.event.pubkey],
    ["Name", resolved.name],
    ["Bytes", String(resolved.size)],
    ["SHA-256", resolved.sha256],
    ["Blossom", resolved.url],
    ["Info hash", resolved.infoHash],
  ]);
  blossomFetchButton.disabled = false;
  swarmFetchButton.disabled = !swarmConsent.checked;
  setStatus(retrieveStatus, "Signed event verified. No file has been downloaded.");
}));

blossomFetchButton.addEventListener("click", () => guard(retrieveStatus, async () => {
  if (!resolved) throw new Error("Resolve a signed event first.");
  setStatus(retrieveStatus, "Downloading from Blossom and verifying exact size and SHA-256…");
  const blob = await fetchVerifiedBlob(resolved);
  retrieveLinks.replaceChildren();
  addDownload(retrieveLinks, blob, resolved.name, `Save verified ${resolved.name}`);
  setStatus(retrieveStatus, "Blossom download verified. The save link points to the checked local bytes.");
}));

swarmConsent.addEventListener("change", () => {
  swarmFetchButton.disabled = !(swarmConsent.checked && resolved);
});

swarmFetchButton.addEventListener("click", () => guard(retrieveStatus, async () => {
  if (!resolved || !swarmConsent.checked) throw new Error("Resolve an event and acknowledge swarm visibility first.");
  if (downloadSession) await downloadSession.stop();
  setStatus(retrieveStatus, "Joining the swarm. Waiting for verified bytes…");
  const result = await downloadFromSwarm(resolved, (progress, speed) => {
    setStatus(retrieveStatus, `Swarm download ${(progress * 100).toFixed(1)}% · ${(speed / 1024).toFixed(1)} KiB/s`);
  });
  downloadSession = result.session;
  retrieveLinks.replaceChildren();
  addDownload(retrieveLinks, result.blob, resolved.name, `Save verified ${resolved.name}`);
  setStatus(retrieveStatus, "Swarm download verified against the signed SHA-256.");
}));

window.addEventListener("beforeunload", () => {
  if (seedSession) void seedSession.stop();
  if (downloadSession) void downloadSession.stop();
});
