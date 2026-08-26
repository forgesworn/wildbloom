import createTorrent from "create-torrent";
import parseTorrent from "parse-torrent";
import type { InspectedFile, TorrentPlan } from "./types.js";
import { assertHex40, normaliseBlossomUrl, normaliseTrackerUrl } from "./security.js";

function makeMagnet(
  infoHash: string,
  name: string,
  size: number,
  trackers: readonly string[],
  webSeed: string,
): string {
  const query = new URLSearchParams();
  query.append("xt", `urn:btih:${infoHash}`);
  query.append("dn", name);
  query.append("xl", String(size));
  for (const tracker of trackers) query.append("tr", tracker);
  query.append("ws", webSeed);
  return `magnet:?${query.toString()}`;
}

export async function createHybridTorrent(
  inspected: InspectedFile,
  blossomUrlInput: string,
  trackerInputs: readonly string[],
): Promise<TorrentPlan> {
  const webSeed = normaliseBlossomUrl(blossomUrlInput, inspected.sha256);
  const trackers = [...new Set(trackerInputs.map(normaliseTrackerUrl))];
  if (trackers.length === 0) throw new Error("At least one WebSocket tracker is required for browser peers to meet.");

  const torrentBytes = await new Promise<Uint8Array>((resolve, reject) => {
    createTorrent(inspected.file, {
      name: inspected.name,
      announceList: trackers.map((tracker) => [tracker]),
      urlList: [webSeed],
      createdBy: "Wildbloom 0.0.1",
      private: false,
    }, (error, torrent) => {
      if (error) reject(error);
      else resolve(new Uint8Array(torrent));
    });
  });

  const parsed = await parseTorrent(torrentBytes);
  const infoHash = assertHex40(parsed.infoHash, "Generated torrent info hash");
  if (parsed.length !== inspected.size || parsed.name !== inspected.name) {
    throw new Error("Generated torrent metadata does not describe the selected file.");
  }
  const magnetUri = makeMagnet(infoHash, inspected.name, inspected.size, trackers, webSeed);
  return {
    torrentBytes,
    torrentBlob: new Blob([torrentBytes as BlobPart], { type: "application/x-bittorrent" }),
    infoHash,
    magnetUri,
    name: inspected.name,
    trackers,
    webSeed,
  };
}
