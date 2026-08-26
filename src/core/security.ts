export const MAX_PROTOTYPE_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_RELAY_MESSAGE_BYTES = 1024 * 1024;

export const HEX_64 = /^[0-9a-f]{64}$/;
export const HEX_40 = /^[0-9a-f]{40}$/;

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function requireSecureTransport(url: URL, secureProtocol: string, localProtocol: string): void {
  if (url.protocol === secureProtocol) return;
  if (url.protocol === localProtocol && isLocalHost(url.hostname)) return;
  throw new Error(`Only ${secureProtocol} endpoints are accepted (or ${localProtocol} localhost for development).`);
}

function rejectCredentials(url: URL): void {
  if (url.username || url.password) throw new Error("Endpoint URLs must not contain credentials.");
}

export function normaliseBlossomServer(value: string): string {
  const url = new URL(value.trim());
  requireSecureTransport(url, "https:", "http:");
  rejectCredentials(url);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("A Blossom server must be an origin only, without a path, query or fragment.");
  }
  return url.origin;
}

export function normaliseBlossomUrl(value: string, expectedHash?: string): string {
  const url = new URL(value.trim());
  requireSecureTransport(url, "https:", "http:");
  rejectCredentials(url);
  if (url.hash) throw new Error("Blossom blob URLs must not contain fragments.");
  if (expectedHash) {
    const matches = url.pathname.match(/[0-9a-f]{64}/g) ?? [];
    if (matches.at(-1) !== expectedHash) {
      throw new Error("The Blossom URL does not contain the expected SHA-256.");
    }
  }
  return url.toString();
}

export function normaliseRelayUrl(value: string): string {
  const url = new URL(value.trim());
  requireSecureTransport(url, "wss:", "ws:");
  rejectCredentials(url);
  if (url.hash) throw new Error("Relay URLs must not contain fragments.");
  return url.toString();
}

export function normaliseTrackerUrl(value: string): string {
  const url = new URL(value.trim());
  requireSecureTransport(url, "wss:", "ws:");
  rejectCredentials(url);
  if (url.hash) throw new Error("Tracker URLs must not contain fragments.");
  return url.toString();
}

export function parseEndpointList(value: string, parser: (entry: string) => string): string[] {
  const entries = value.split(/[\n,]/u).map((entry) => entry.trim()).filter(Boolean);
  return [...new Set(entries.map(parser))];
}

export function sanitiseFileName(value: string): string {
  const leaf = value.split(/[\\/]/u).at(-1) ?? "";
  const cleaned = leaf
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[<>:"|?*]/gu, "_")
    .replace(/^\.+/u, "")
    .trim();
  const fallback = cleaned || "blob.bin";
  return fallback.length <= 180 ? fallback : fallback.slice(0, 180);
}

export function fileExtension(name: string): string {
  const match = /\.([a-z0-9]{1,10})$/iu.exec(name);
  return match?.[1]?.toLowerCase() ?? "bin";
}

export function assertPrototypeFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Choose a non-empty file.");
  if (size > MAX_PROTOTYPE_FILE_BYTES) {
    throw new Error(`This prototype is limited to ${MAX_PROTOTYPE_FILE_BYTES / 1024 / 1024} MiB files.`);
  }
}

export function assertHex64(value: string, label: string): string {
  const normalised = value.toLowerCase();
  if (!HEX_64.test(normalised)) throw new Error(`${label} must be 64 lowercase hexadecimal characters.`);
  return normalised;
}

export function assertHex40(value: string, label: string): string {
  const normalised = value.toLowerCase();
  if (!HEX_40.test(normalised)) throw new Error(`${label} must be a 40-character BitTorrent v1 info hash.`);
  return normalised;
}

export function safeDiagnostic(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 300);
}
