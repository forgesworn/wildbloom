import { sha256Hex } from "./crypto.js";
import { safeDiagnostic } from "./security.js";
import type { InspectedFile, NetworkProfile, ResolvedHybridEvent, StopHandle, TorrentPlan } from "./types.js";

const SWARM_TIMEOUT_MS = 30 * 60 * 1000;
const SWARM_START_TIMEOUT_MS = 30_000;
function privateWebTorrentClientOptions() {
  // WebTorrent otherwise inherits public Google and Twilio STUN servers from
  // simple-peer. Wildbloom never contacts undeclared ICE infrastructure. This
  // host-candidate-only policy is intentionally conservative: cross-network
  // connectivity needs a separately reviewed, explicitly configured service.
  return {
    tracker: { rtcConfig: { iceServers: [] } },
    dht: false,
    lsd: false,
    natPmp: false,
    natUpnp: false,
    utp: false,
  };
}
type WebTorrentConstructor = typeof import("webtorrent/dist/webtorrent.min.js")["default"];
export type WebTorrentLoader = () => Promise<{ default: WebTorrentConstructor }>;
const loadWebTorrent: WebTorrentLoader = () => import("webtorrent/dist/webtorrent.min.js");

async function destroyClient(client: { destroy(callback?: (error?: Error) => void): void }): Promise<void> {
  await new Promise<void>((resolve) => client.destroy(() => resolve()));
}

export async function startBrowserSeeding(
  inspected: InspectedFile,
  plan: TorrentPlan,
  profile: NetworkProfile = "direct",
  loader: WebTorrentLoader = loadWebTorrent,
  signal?: AbortSignal,
): Promise<StopHandle> {
  if (profile === "tor") throw new Error("WebTorrent is disabled in Tor-only mode.");
  if (signal?.aborted) throw new Error("WebTorrent seeding cancelled.");
  const { default: WebTorrent } = await loader();
  if (signal?.aborted) throw new Error("WebTorrent seeding cancelled.");
  const client = new WebTorrent(privateWebTorrentClientOptions());
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void destroyClient(client);
      reject(new Error("WebTorrent seeding cancelled."));
    };
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      void destroyClient(client);
      reject(new Error("WebTorrent did not start seeding before the safety timeout."));
    }, SWARM_START_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    client.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        void destroyClient(client);
        reject(new Error(`WebTorrent failed: ${safeDiagnostic(error)}`));
      }
    });
    client.seed(inspected.file, {
      name: inspected.name,
      announceList: plan.trackers.map((tracker) => [tracker]),
      urlList: [plan.webSeed],
      private: false,
    }, (torrent) => {
      if (settled) return;
      if (torrent.infoHash.toLowerCase() !== plan.infoHash) {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        void destroyClient(client);
        reject(new Error("WebTorrent generated a different info hash from the reviewed torrent metadata."));
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ stop: () => destroyClient(client) });
    });
  });
}

export async function downloadFromSwarm(
  resolved: ResolvedHybridEvent,
  onProgress: (progress: number, bytesPerSecond: number) => void,
  profile: NetworkProfile = "direct",
  loader: WebTorrentLoader = loadWebTorrent,
  signal?: AbortSignal,
): Promise<{ blob: Blob; session: StopHandle }> {
  if (profile === "tor") throw new Error("WebTorrent is disabled in Tor-only mode.");
  if (signal?.aborted) throw new Error("Swarm download cancelled.");
  if (!resolved.magnetUri || !resolved.infoHash || resolved.trackers.length === 0) {
    throw new Error("The signed event does not contain a usable WebTorrent transport.");
  }
  const { default: WebTorrent } = await loader();
  const client = new WebTorrent(privateWebTorrentClientOptions());
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = (): void => fail(new Error("Swarm download cancelled."));
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void destroyClient(client);
      reject(error instanceof Error ? error : new Error(safeDiagnostic(error)));
    };
    const timer = globalThis.setTimeout(() => fail(new Error("Swarm download timed out.")), SWARM_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    client.on("error", fail);
    client.add(resolved.magnetUri as string, {}, (torrent) => {
      if (settled) return;
      if (torrent.infoHash.toLowerCase() !== resolved.infoHash || torrent.length !== resolved.size) {
        fail(new Error("Torrent metadata does not match the signed Nostr event."));
        return;
      }
      if (torrent.files.length !== 1 || torrent.files[0]?.length !== resolved.size) {
        fail(new Error("Wildbloom accepts one-file torrents only."));
        return;
      }
      torrent.on("download", () => {
        if (!settled) onProgress(torrent.progress, torrent.downloadSpeed);
      });
      void torrent.files[0].blob().then((blob) => {
        if (settled) return;
        return sha256Hex(blob).then((hash) => {
          if (settled) return;
          if (hash !== resolved.sha256) {
            fail(new Error("Swarm bytes failed the signed SHA-256 check."));
            return;
          }
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve({ blob, session: { stop: () => destroyClient(client) } });
        });
      }).catch(fail);
    });
  });
}
