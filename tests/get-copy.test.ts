import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COPY, formatBytes, formatClock } from "../src/get/copy.js";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const FORBIDDEN = /nostr|blossom|relay|\bkeys?\b|hash|\bnodes?\b|signer|foregather/iu;

describe("recipient copy", () => {
  it("names none of the technical terms the recipient should never meet", () => {
    expect(FORBIDDEN.exec(read("../src/get/copy.ts"))).toBeNull();
    const html = read("../get.html").replace(/<meta[^>]*>/gu, "").replace(/<script[^>]*><\/script>/gu, "");
    expect(FORBIDDEN.exec(html)).toBeNull();
  });

  it("uses no em dash anywhere on the recipient page", () => {
    for (const path of ["../src/get/copy.ts", "../src/get/main.ts", "../src/get/state.ts", "../src/get/get.css", "../get.html"]) {
      expect(read(path)).not.toContain("—");
    }
  });

  it("keeps user-visible strings out of the page script", () => {
    // A quoted string that starts like a sentence: a capital, then words.
    expect(/"[A-Z][a-z]+ [a-z]/u.exec(read("../src/get/main.ts"))).toBeNull();
  });

  it("keeps the no-script text in the page identical to the copy file", () => {
    const html = read("../get.html");
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/u.exec(html)?.[1] ?? "";
    expect(noscript).toContain(COPY.noScript);
    expect(noscript).toContain("Get your file");
  });

  it("states the footer and the offline banner exactly", () => {
    expect(COPY.footer).toBe("This is new software and hasn't been independently audited yet.");
    expect(COPY.offlineBanner).toBe("You're offline. Connect to the internet to continue.");
  });

  it("pluralises the word count message", () => {
    expect(COPY.words.wrongCount(1)).toBe("That's 1 word. You need 4.");
    expect(COPY.words.wrongCount(2)).toBe("That's 2 words. You need 4.");
    expect(COPY.words.unknown("candel")).toBe("“candel” isn't one of the words. Check the spelling.");
    expect(COPY.words.useSuggestion("cancel")).toBe("Use “cancel”");
  });

  it("formats sizes in decimal units and the countdown as m:ss", () => {
    expect(formatBytes(43)).toBe("43 B");
    expect(formatBytes(24_300_000)).toBe("24.3 MB");
    expect(formatBytes(1_500)).toBe("1.5 kB");
    expect(formatBytes(250_000_000)).toBe("250 MB");
    expect(formatBytes(3_200_000_000)).toBe("3.2 GB");
    expect(formatClock(552)).toBe("9:12");
    expect(formatClock(5)).toBe("0:05");
    expect(formatClock(-3)).toBe("0:00");
  });

  it("writes the saved-file screen with the file name", () => {
    expect(COPY.screens.r18.body("holiday-photos.zip")).toBe(
      "Your browser has saved holiday-photos.zip. If you can't find it, look in your downloads or save it again. You can close this page.",
    );
  });
});
