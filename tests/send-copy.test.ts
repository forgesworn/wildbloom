import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COPY, formatBytes } from "../src/send/copy.js";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
// The person sending a file should never meet these words.
const FORBIDDEN = /nostr|blossom|relay|\bkeys?\b|hash|\bnodes?\b|signer|foregather|encrypt|invitation|grant/iu;

/** Every string a person can read, including those a function builds, for a few sample names and sizes. */
function allCopy(): string[] {
  const strings: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") strings.push(value);
    else if (typeof value === "function") {
      for (const argument of ["holiday.mp4", "250 MB", "4:05", 7, 25]) {
        try {
          const result = (value as (input: unknown) => unknown)(argument);
          if (typeof result === "string") strings.push(result);
        } catch {
          // A function built for another argument type.
        }
      }
    } else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(COPY);
  return strings;
}

describe("sender copy", () => {
  it("names none of the technical terms the sender should never meet", () => {
    expect(FORBIDDEN.exec(read("../src/send/copy.ts"))).toBeNull();
    const html = read("../send.html").replace(/<meta[^>]*>/gu, "").replace(/<script[^>]*><\/script>/gu, "");
    expect(FORBIDDEN.exec(html)).toBeNull();
    for (const text of allCopy()) expect(FORBIDDEN.exec(text), text).toBeNull();
  });

  it("uses no em dash anywhere on the sender page", () => {
    for (const path of ["../src/send/copy.ts", "../src/send/main.ts", "../src/send/state.ts", "../send.html"]) {
      expect(read(path)).not.toContain("—");
    }
    for (const text of allCopy()) expect(text).not.toContain("—");
  });

  it("keeps user-visible strings out of the page script", () => {
    // A quoted string that starts like a sentence: a capital, then words.
    expect(/"[A-Z][a-z]+ [a-z]/u.exec(read("../src/send/main.ts"))).toBeNull();
  });

  it("uses British spelling and no exclamation marks", () => {
    const american = /\b(?:color|center|organize|recognize|favorite|license|gray|catalog)\b/iu;
    for (const text of allCopy()) {
      expect(american.exec(text), text).toBeNull();
      expect(text).not.toContain("!");
    }
  });

  it("keeps the no-script text in the page identical to the copy file", () => {
    const html = read("../send.html");
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/u.exec(html)?.[1] ?? "";
    expect(noscript).toContain(COPY.noScript);
    expect(noscript).toContain("Send a file");
  });

  it("says what the design table says on the main screens", () => {
    const { screens } = COPY;
    expect(screens.words).toEqual({ h1: "Send a file", body: "Type the 4 words they told you." });
    expect(screens.connecting).toEqual({ h1: "Connecting", body: "Keep this page open." });
    expect(screens.waiting).toEqual({ h1: "Waiting for them", body: "Ask them to keep Wildbloom open. Keep this page open." });
    expect(screens.check).toEqual({ h1: "Check these words with them", body: "They'll read you 3 words. Do they match?" });
    expect(screens.confirming).toEqual({ h1: "Waiting for them", body: "They need to confirm the words on their computer. Keep this page open." });
    expect(screens.choose.h1).toBe("Choose a file");
    expect(screens.choose.body("250 MB")).toBe("It's locked on this phone before it's sent, so only they can open it. Up to 250 MB.");
    expect(screens.preparing).toMatchObject({ h1: "Getting it ready" });
    expect(screens.preparing.body("holiday.mp4")).toBe("Locking holiday.mp4 on this phone.");
    expect(screens.sending.h1("holiday.mp4")).toBe("Sending holiday.mp4");
    expect(screens.sending.body).toBe("Keep this page open until it's sent.");
    expect(screens.sent.h1).toBe("Sent");
    expect(screens.sent.body("holiday.mp4")).toBe("holiday.mp4 has reached their storage. You can close this page.");
    expect(screens.tooBig.h1).toBe("This file is too big");
    expect(screens.tooBig.body("250 MB")).toBe("You can send up to 250 MB.");
    expect(screens.empty.h1).toBe("That file is empty");
    expect(screens.stopped).toEqual({ h1: "Sending stopped", body: "Check your internet connection, then try again." });
    expect(screens.ended).toEqual({ h1: "This request has ended", body: "Ask them to send you a new request." });
    expect(COPY.buttons.chooseFile).toBe("Choose a file");
    expect(COPY.buttons.chooseAnother).toBe("Choose another file");
  });

  it("rewords the recipient screens for a request, never mentioning a share", () => {
    for (const key of ["expired", "used", "wrongWords", "mismatch", "invalid", "cancelled", "incomplete"] as const) {
      const { h1, body } = COPY.screens[key];
      expect(`${h1} ${body}`).not.toMatch(/\bshar(?:e|ed|ing)\b/iu);
    }
    expect(COPY.screens.expired.body).toBe("Links work for 10 minutes. Ask them to send you a new request.");
    expect(COPY.screens.used.h1).toBe("This link has already been used");
    expect(COPY.screens.wrongWords.h1).toBe("Those words didn't work");
    expect(COPY.screens.mismatch.h1).toBe("Nothing was sent");
    expect(COPY.screens.unsupported.h1).toBe("This browser can't send the file");
  });

  it("shares the recipient page's footer, offline banner and words messages exactly", () => {
    expect(COPY.footer).toBe("This is new software and hasn't been independently audited yet.");
    expect(COPY.offlineBanner).toBe("You're offline. Connect to the internet to continue.");
    expect(COPY.words.wrongCount(1)).toBe("That's 1 word. You need 4.");
    expect(COPY.words.hint(3)).toBe("3 of 4 words");
  });

  it("formats the limit in decimal units, as phone storage screens do", () => {
    expect(formatBytes(250_000_000)).toBe("250 MB");
    expect(formatBytes(45_000_000)).toBe("45.0 MB");
  });
});
