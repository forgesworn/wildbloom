import { describe, expect, it } from "vitest";
import { DISGUISING_CHARACTERS, decodeMessage } from "../src/direct/messages.js";
import { plainName, prepareSource } from "../src/send/source.js";

// The protocol's list, range by range: the Arabic letter mark, the Mongolian vowel separator, the zero-width and
// directional marks, the embeddings and overrides, the word joiner and invisible operators, the isolates, the
// deprecated formatting characters, the byte order mark and the tag characters.
const RANGES: readonly (readonly [number, number])[] = [
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0x206a, 0x206f],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];
const listed = (code: number): boolean => RANGES.some(([low, high]) => code >= low && code <= high);
const DISGUISING: readonly number[] = RANGES.flatMap(([low, high]) => Array.from({ length: high - low + 1 }, (_, index) => low + index));
const hex = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
const manifestWithName = (name: string): Uint8Array => new TextEncoder().encode(JSON.stringify({ event: "manifest", name, size: 5, type: "application/pdf", v: 1 }));
const context = { from: "page", index: 0, iceAllowlist: [], max: 250_000_000 } as const;
const accepted = (name: string): boolean => decodeMessage(manifestWithName(name), context).ok;

describe("names that disguise their extension", () => {
  it("covers exactly the characters the protocol names", () => {
    expect(DISGUISING).toHaveLength(1 + 1 + 5 + 5 + 5 + 4 + 6 + 1 + 128);
    for (const code of DISGUISING) expect(`a${String.fromCodePoint(code)}b`.replace(DISGUISING_CHARACTERS, ""), hex(code)).toBe("ab");
  });

  it.each(RANGES.map(([low, high]) => [`${hex(low)} to ${hex(high)}`, low, high] as const))("holds %s to its edges: both ends are in, the characters either side are not", (_label, low, high) => {
    for (const code of [low, high]) {
      expect(accepted(`invoice${String.fromCodePoint(code)}fdp.terminal`), `${hex(code)} is refused`).toBe(false);
      expect(plainName(`a${String.fromCodePoint(code)}b`), `${hex(code)} is stripped`).toBe("ab");
    }
    // The characters either side are ordinary, unless another range begins there.
    for (const code of [low - 1, high + 1]) {
      const name = `a${String.fromCodePoint(code)}b.pdf`;
      if (listed(code)) {
        expect(accepted(name), `${hex(code)} is in the next range`).toBe(false);
      } else {
        expect(accepted(name), `${hex(code)} is not in the list`).toBe(true);
        expect(plainName(name), `${hex(code)} is kept`).toBe(name);
      }
    }
  });

  it("leaves the characters just outside the ranges as they are", () => {
    for (const code of [0x061b, 0x061d, 0x180d, 0x180f, 0x2009, 0x200a, 0x2010, 0x202f, 0x205f, 0x2065, 0x2070, 0xfefe, 0xff00, 0xdffff, 0xe0080]) {
      expect(listed(code), hex(code)).toBe(false);
      const name = `a${String.fromCodePoint(code)}b`;
      expect(plainName(name)).toBe(name);
    }
  });

  it("refuses every one of them in a manifest, in the middle of a name or at either end, as failed", () => {
    for (const code of DISGUISING) {
      for (const name of [`invoice${String.fromCodePoint(code)}fdp.terminal`, `${String.fromCodePoint(code)}report.pdf`, `report.pdf${String.fromCodePoint(code)}`]) {
        const result = decodeMessage(manifestWithName(name), context);
        expect(result.ok, `${hex(code)} in ${name.length} units`).toBe(false);
        if (!result.ok) expect(result.stop).toBe("failed");
      }
    }
  });

  it("is refused whichever way the manifest spells it, and an honest name still passes", () => {
    // The override, written as an escape rather than the character, is refused too (the canonical form is the character).
    expect(decodeMessage(new TextEncoder().encode('{"event":"manifest","name":"invoice\\u202efdp.terminal","size":5,"type":"application/pdf","v":1}'), context)).toMatchObject({ ok: false, stop: "failed" });
    expect(decodeMessage(manifestWithName("invoice.pdf"), context)).toMatchObject({ ok: true });
    expect(decodeMessage(manifestWithName("Café holiday – 2026.pdf"), context)).toMatchObject({ ok: true });
    // Characters next to the ranges are ordinary.
    expect(decodeMessage(manifestWithName("a⁥b.pdf"), context)).toMatchObject({ ok: true });
  });

  it("is removed from the name the phone sends, so an honest file still goes", () => {
    expect(plainName("invoice‮fdp.terminal")).toBe("invoicefdp.terminal");
    for (const code of DISGUISING) expect(plainName(`a${String.fromCodePoint(code)}b.txt`), hex(code)).toBe("ab.txt");
    const prepared = prepareSource(new File(["x"], "invoice‮fdp.terminal", { type: "application/pdf" }));
    expect(prepared.name).toBe("invoicefdp.terminal");
    // What the phone makes of it is what the receiver accepts.
    expect(decodeMessage(manifestWithName(prepared.name), context)).toMatchObject({ ok: true });
  });

  it("leaves a name with none of them as it was, and a name made only of them as the fallback", () => {
    expect(prepareSource(new File(["x"], "plain name.txt")).name).toBe("plain name.txt");
    expect(prepareSource(new File(["x"], "‮​﻿")).name).toBe("blob.bin");
    expect(prepareSource(new File(["x"], `${"‮".repeat(300)}ok.txt`)).name).toBe("ok.txt");
  });

  it("removes them before the leading dots and spaces are, so a hidden dot cannot survive", () => {
    expect(prepareSource(new File(["x"], "​.​.hidden")).name).toBe("hidden");
    expect(prepareSource(new File(["x"], " ⁠ name.txt")).name).toBe("name.txt");
  });
});
