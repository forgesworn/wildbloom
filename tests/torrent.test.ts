import parseTorrent from "parse-torrent";
import { describe, expect, it } from "vitest";
import { inspectFile } from "../src/core/blossom.js";
import { createHybridTorrent } from "../src/core/torrent.js";

describe("hybrid torrent metadata", () => {
  it("binds one file, trackers and a verified Blossom web seed", async () => {
    const inspected = await inspectFile(new File(["hello world"], "hello.txt", { type: "text/plain" }));
    const webSeed = `https://cdn.example.com/${inspected.sha256}.txt`;
    const plan = await createHybridTorrent(inspected, webSeed, ["wss://tracker.example.com/announce"]);
    const parsed = await parseTorrent(plan.torrentBytes);
    expect(parsed.name).toBe("hello.txt");
    expect(parsed.length).toBe(11);
    expect(parsed.urlList).toContain(webSeed);
    expect(plan.magnetUri).toContain(`xt=urn%3Abtih%3A${plan.infoHash}`);
    expect(plan.magnetUri).toContain("ws=https%3A%2F%2Fcdn.example.com");
  });

  it("refuses to create a browser torrent without a WebSocket tracker", async () => {
    const inspected = await inspectFile(new File(["hello"], "hello.txt"));
    await expect(createHybridTorrent(inspected, `https://cdn.example.com/${inspected.sha256}.txt`, []))
      .rejects.toThrow(/tracker/u);
  });
});
