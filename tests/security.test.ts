import { describe, expect, it } from "vitest";
import {
  assertPrototypeFileSize,
  fileExtension,
  normaliseBlossomServer,
  normaliseRelayUrl,
  normaliseTrackerUrl,
  sanitiseFileName,
} from "../src/core/security.js";

describe("secure endpoint handling", () => {
  it("accepts secure remote services and explicit local development", () => {
    expect(normaliseBlossomServer("https://cdn.example.com/")).toBe("https://cdn.example.com");
    expect(normaliseRelayUrl("wss://relay.example.com/path")).toBe("wss://relay.example.com/path");
    expect(normaliseTrackerUrl("ws://localhost:8000/announce")).toBe("ws://localhost:8000/announce");
  });

  it("rejects remote plaintext and embedded credentials", () => {
    expect(() => normaliseBlossomServer("http://cdn.example.com")).toThrow(/https/u);
    expect(() => normaliseRelayUrl("wss://user:pass@relay.example.com")).toThrow(/credentials/u);
    expect(() => normaliseTrackerUrl("http://tracker.example.com")).toThrow(/wss/u);
  });

  it("requires Blossom origins rather than attacker-controlled paths", () => {
    expect(() => normaliseBlossomServer("https://cdn.example.com/upload")).toThrow(/origin only/u);
    expect(() => normaliseBlossomServer("https://cdn.example.com/?next=evil")).toThrow(/origin only/u);
  });
});

describe("file boundaries", () => {
  it("removes paths and control characters from display names", () => {
    expect(sanitiseFileName("../../private/<demo>\u0000.txt")).toBe("_demo_.txt");
    expect(sanitiseFileName(".../../")).toBe("blob.bin");
  });

  it("uses a conservative extension fallback", () => {
    expect(fileExtension("photo.JPEG")).toBe("jpeg");
    expect(fileExtension("README")).toBe("bin");
    expect(fileExtension("file.this-extension-is-too-long")).toBe("bin");
  });

  it("rejects empty and oversized files", () => {
    expect(() => assertPrototypeFileSize(0)).toThrow(/non-empty/u);
    expect(() => assertPrototypeFileSize(256 * 1024 * 1024 + 1)).toThrow(/limited/u);
  });
});
