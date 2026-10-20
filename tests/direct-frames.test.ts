// The data-channel frames, against the shared vectors (see direct-messages.test.ts for their provenance).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeAck, encodeData, encodeEnd, encodeStop, FrameError, encodeKept, type Frame, type Role } from "../src/direct/frames.js";

interface Vectors {
  frames: { name: string; from: "page" | "drop"; hex: string }[];
  frameRefusals: { name: string; from: "page" | "drop"; hex: string }[];
}
const vectors = JSON.parse(readFileSync(new URL("../test-vectors/wildbloom-direct-v1.json", import.meta.url), "utf8")) as Vectors;
// In to-drop the page sends the file and Drop receives it.
const role = (from: "page" | "drop"): Role => (from === "page" ? "sender" : "receiver");
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const fromHex = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, "hex"));

describe("data-channel frames", () => {
  it.each(vectors.frames.map((entry) => [entry.name, entry] as const))("reads %s and writes it back", (_name, entry) => {
    const frame = decodeFrame(role(entry.from), fromHex(entry.hex));
    const again: Record<Frame["type"], (f: never) => Uint8Array> = {
      data: (f: Extract<Frame, { type: "data" }>) => encodeData(f.offset, f.bytes),
      ack: (f: Extract<Frame, { type: "ack" }>) => encodeAck(f.next),
      end: (f: Extract<Frame, { type: "end" }>) => encodeEnd(f.sha256, f.size),
      kept: () => encodeKept(),
      stop: (f: Extract<Frame, { type: "stop" }>) => encodeStop(f.code),
    };
    expect(hex(again[frame.type](frame as never))).toBe(entry.hex);
  });

  it.each(vectors.frameRefusals.map((entry) => [entry.name, entry] as const))("refuses %s", (_name, entry) => {
    expect(() => decodeFrame(role(entry.from), fromHex(entry.hex))).toThrow(FrameError);
  });

  it("reads the numbers the vectors show", () => {
    expect(decodeFrame("sender", fromHex("01000000000001000000ff"))).toMatchObject({ type: "data", offset: 65_536 });
    expect(decodeFrame("receiver", fromHex("020000000000100000"))).toEqual({ type: "ack", next: 1_048_576 });
    expect(decodeFrame("sender", fromHex(vectors.frames[3]!.hex))).toMatchObject({ type: "end", size: 43 });
  });

  it("reads an unknown STOP reason as 2 and keeps 1 and 3", () => {
    expect(decodeFrame("sender", Uint8Array.of(5, 1))).toEqual({ type: "stop", code: 1 });
    expect(decodeFrame("receiver", Uint8Array.of(5, 3))).toEqual({ type: "stop", code: 3 });
    expect(decodeFrame("receiver", Uint8Array.of(5, 0))).toEqual({ type: "stop", code: 2 });
    expect(decodeFrame("receiver", Uint8Array.of(5, 200))).toEqual({ type: "stop", code: 2 });
  });

  it("accepts the largest DATA frame and refuses one byte more", () => {
    const largest = encodeData(0, new Uint8Array(65_527));
    expect(largest.length).toBe(65_536);
    expect(decodeFrame("sender", largest)).toMatchObject({ type: "data" });
    expect(() => decodeFrame("sender", new Uint8Array(65_537).fill(1, 0, 1))).toThrow(FrameError);
    expect(() => encodeData(0, new Uint8Array(65_528))).toThrow(RangeError);
    expect(() => encodeData(0, new Uint8Array(0))).toThrow(RangeError);
  });

  it("carries offsets past 32 bits and refuses ones past 2^53 - 1", () => {
    const offset = 2 ** 40 + 7;
    expect(decodeFrame("receiver", encodeAck(offset))).toEqual({ type: "ack", next: offset });
    expect(() => decodeFrame("receiver", fromHex("02ffffffffffffffff"))).toThrow(FrameError);
    expect(() => encodeAck(2 ** 53)).toThrow(RangeError);
    expect(() => encodeEnd(new Uint8Array(31), 1)).toThrow(RangeError);
  });

  it("copies the digest out of END so a later write to the buffer cannot change it", () => {
    const buffer = encodeEnd(new Uint8Array(32).fill(7), 9);
    const frame = decodeFrame("sender", buffer);
    buffer.fill(0);
    expect(frame).toMatchObject({ type: "end" });
    expect((frame as Extract<Frame, { type: "end" }>).sha256).toEqual(new Uint8Array(32).fill(7));
  });
});
