import createTorrent from "create-torrent";
import parseTorrent from "parse-torrent";
import type { InspectedFile, TorrentPlan } from "./types.js";
import { assertHex40, MAX_NETWORK_ENDPOINTS, normaliseBlossomUrl, normaliseTrackerUrl } from "./security.js";

function makeMagnet(
  infoHash: string,
  name: string,
  size: number,
  trackers: readonly string[],
  webSeed: string,
): string {
  const parameters = [
    `xt=urn:btih:${infoHash}`,
    `dn=${encodeURIComponent(name)}`,
    `xl=${size}`,
    ...trackers.map((tracker) => `tr=${encodeURIComponent(tracker)}`),
    `ws=${encodeURIComponent(webSeed)}`,
  ];
  return `magnet:?${parameters.join("&")}`;
}

export async function createHybridTorrent(
  inspected: InspectedFile,
  blossomUrlInput: string,
  trackerInputs: readonly string[],
): Promise<TorrentPlan> {
  const webSeed = normaliseBlossomUrl(blossomUrlInput, inspected.sha256);
  if (trackerInputs.length > MAX_NETWORK_ENDPOINTS) throw new Error(`At most ${MAX_NETWORK_ENDPOINTS} trackers may be used.`);
  const trackers = [...new Set(trackerInputs.map((tracker) => normaliseTrackerUrl(tracker)))];
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
  if (!parsed.files || parsed.files.length !== 1 || parsed.files[0]?.length !== inspected.size) {
    throw new Error("Generated torrent metadata is not a one-file torrent.");
  }
  if (!parsed.urlList || parsed.urlList.length !== 1 || parsed.urlList[0] !== webSeed) {
    throw new Error("Generated torrent metadata changed the reviewed Blossom web seed.");
  }
  const parsedTrackers = [...new Set(parsed.announce.map((tracker) => normaliseTrackerUrl(tracker)))];
  if (JSON.stringify(parsedTrackers) !== JSON.stringify(trackers)) {
    throw new Error("Generated torrent metadata changed the reviewed trackers.");
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
