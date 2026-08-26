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
): Promise<StopHandle> {
  if (profile === "tor") throw new Error("WebTorrent is disabled in Tor-only mode.");
  const { default: WebTorrent } = await loader();
  const client = new WebTorrent(privateWebTorrentClientOptions());
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      void destroyClient(client);
      reject(new Error("WebTorrent did not start seeding before the safety timeout."));
    }, SWARM_START_TIMEOUT_MS);
    client.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
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
      if (torrent.infoHash.toLowerCase() !== plan.infoHash) {
        settled = true;
        clearTimeout(timer);
        void destroyClient(client);
        reject(new Error("WebTorrent generated a different info hash from the reviewed torrent metadata."));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stop: () => destroyClient(client) });
    });
  });
}

export async function downloadFromSwarm(
  resolved: ResolvedHybridEvent,
  onProgress: (progress: number, bytesPerSecond: number) => void,
  profile: NetworkProfile = "direct",
  loader: WebTorrentLoader = loadWebTorrent,
): Promise<{ blob: Blob; session: StopHandle }> {
  if (profile === "tor") throw new Error("WebTorrent is disabled in Tor-only mode.");
  if (!resolved.magnetUri || !resolved.infoHash || resolved.trackers.length === 0) {
    throw new Error("The signed event does not contain a usable WebTorrent transport.");
  }
  const { default: WebTorrent } = await loader();
  const client = new WebTorrent(privateWebTorrentClientOptions());
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void destroyClient(client);
      reject(error instanceof Error ? error : new Error(safeDiagnostic(error)));
    };
    const timer = globalThis.setTimeout(() => fail(new Error("Swarm download timed out.")), SWARM_TIMEOUT_MS);
    client.on("error", fail);
    client.add(resolved.magnetUri as string, {}, (torrent) => {
      if (torrent.infoHash.toLowerCase() !== resolved.infoHash || torrent.length !== resolved.size) {
        fail(new Error("Torrent metadata does not match the signed Nostr event."));
        return;
      }
      if (torrent.files.length !== 1 || torrent.files[0]?.length !== resolved.size) {
        fail(new Error("Wildbloom accepts one-file torrents only."));
        return;
      }
      torrent.on("download", () => onProgress(torrent.progress, torrent.downloadSpeed));
      torrent.files[0].getBlob((error, blob) => {
        if (error || !blob) {
          fail(error ?? new Error("WebTorrent did not return the downloaded file."));
          return;
        }
        void sha256Hex(blob).then((hash) => {
          if (hash !== resolved.sha256) {
            fail(new Error("Swarm bytes failed the signed SHA-256 check."));
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve({ blob, session: { stop: () => destroyClient(client) } });
        }).catch(fail);
      });
    });
  });
}
