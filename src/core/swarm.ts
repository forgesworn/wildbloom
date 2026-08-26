import { sha256Hex } from "./crypto.js";
import { safeDiagnostic } from "./security.js";
import type { InspectedFile, ResolvedHybridEvent, StopHandle, TorrentPlan } from "./types.js";

const SWARM_TIMEOUT_MS = 30 * 60 * 1000;

async function destroyClient(client: { destroy(callback?: (error?: Error) => void): void }): Promise<void> {
  await new Promise<void>((resolve) => client.destroy(() => resolve()));
}

export async function startBrowserSeeding(inspected: InspectedFile, plan: TorrentPlan): Promise<StopHandle> {
  const { default: WebTorrent } = await import("webtorrent/dist/webtorrent.min.js");
  const client = new WebTorrent();
  return new Promise((resolve, reject) => {
    let settled = false;
    client.on("error", (error) => {
      if (!settled) reject(new Error(`WebTorrent failed: ${safeDiagnostic(error)}`));
    });
    client.seed(inspected.file, {
      name: inspected.name,
      announceList: plan.trackers.map((tracker) => [tracker]),
      urlList: [plan.webSeed],
      private: false,
    }, (torrent) => {
      if (torrent.infoHash.toLowerCase() !== plan.infoHash) {
        void destroyClient(client);
        reject(new Error("WebTorrent generated a different info hash from the reviewed torrent metadata."));
        return;
      }
      settled = true;
      resolve({ stop: () => destroyClient(client) });
    });
  });
}

export async function downloadFromSwarm(
  resolved: ResolvedHybridEvent,
  onProgress: (progress: number, bytesPerSecond: number) => void,
): Promise<{ blob: Blob; session: StopHandle }> {
  const { default: WebTorrent } = await import("webtorrent/dist/webtorrent.min.js");
  const client = new WebTorrent();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void destroyClient(client);
      reject(error instanceof Error ? error : new Error(safeDiagnostic(error)));
    };
    const timer = window.setTimeout(() => fail(new Error("Swarm download timed out.")), SWARM_TIMEOUT_MS);
    client.on("error", fail);
    client.add(resolved.magnetUri, {}, (torrent) => {
      if (torrent.infoHash.toLowerCase() !== resolved.infoHash || torrent.length !== resolved.size) {
        fail(new Error("Torrent metadata does not match the signed Nostr event."));
        return;
      }
      if (torrent.files.length !== 1 || torrent.files[0]?.length !== resolved.size) {
        fail(new Error("This prototype accepts one-file torrents only."));
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
