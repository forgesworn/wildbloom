import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COPY, formatBytes } from "../src/send/copy.js";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
// The person sending a file should never meet these words.
const FORBIDDEN = /nostr|blossom|relay|\bkeys?\b|hash|\bnodes?\b|signer|foregather|encrypt|invitation|grant|turn server|\bice\b|webrtc/iu;
// The page does not know how long a send will take or how fast it will go, so it never says.
const ESTIMATES = /[kmg]b\/s|\bmbps\b|per second|\babout \d|\broughly\b|\baround\b|\bestimated\b|\bfast\b|\bin a few\b|\bseconds?\b|\bhours?\b/iu;

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
    expect(FORBIDDEN.exec(read("../src/send/copy.ts").replace(/^\/\/.*$/gmu, ""))).toBeNull();
    const html = read("../send.html").replace(/<meta[^>]*>/gu, "").replace(/<script[^>]*><\/script>/gu, "");
    expect(FORBIDDEN.exec(html)).toBeNull();
    for (const text of allCopy()) expect(FORBIDDEN.exec(text), text).toBeNull();
  });

  it("promises no time and no speed", () => {
    for (const text of allCopy()) expect(ESTIMATES.exec(text), text).toBeNull();
  });

  it("uses no em dash anywhere on the sender page", () => {
    for (const path of ["../src/send/copy.ts", "../src/send/main.ts", "../src/send/state.ts", "../src/send/send.css", "../send.html"]) {
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
    const noscript = /<noscript>([\s\S]*?)<\/noscript>/u.exec(read("../send.html"))?.[1] ?? "";
    expect(noscript).toContain(COPY.noScript);
    expect(noscript).toContain("Send a file");
  });

  it("says what the design says on the main screens", () => {
    const { screens } = COPY;
    expect(screens.words).toEqual({ h1: "Send a file", body: "Type the 4 words they told you." });
    expect(screens.check).toEqual({ h1: "Check these words with them", body: "They'll read you 3 words. Do they match?" });
    expect(screens.confirming).toEqual({ h1: "Waiting for them", body: "They need to confirm the words on their computer. Keep this page open." });
    expect(screens.choose.h1).toBe("Choose a file");
    expect(screens.choose.body("250 MB")).toContain("Up to 250 MB.");
    expect(screens.asking.h1).toBe("Waiting for them to accept");
    expect(screens.sending.h1("holiday.mp4")).toBe("Sending holiday.mp4");
    expect(screens.sending.body).toBe("Keep this page open until it's sent.");
    expect(screens.sent.h1).toBe("Sent");
    expect(screens.sent.body("holiday.mp4")).toBe("holiday.mp4 is on their computer. You can close this page.");
    expect(screens.declined).toEqual({ h1: "They said no", body: "Nothing was sent." });
    expect(screens.tooBig.body("250 MB")).toBe("You can send up to 250 MB.");
    expect(COPY.hide.label).toBe("Don't show them my internet address");
    expect(COPY.buttons.chooseFile).toBe("Choose a file");
  });

  it("tells a person what became of the file on every screen that ends the send", () => {
    for (const key of ["cannotHide", "noRoom", "connectFailed", "lost", "theyStopped", "failed", "cancelled", "declined", "mismatch"] as const) {
      const { h1, body } = COPY.screens[key];
      expect(`${h1} ${body}`, h1).toMatch(/nothing was (?:sent|kept)/iu);
    }
  });

  it("says honestly what hiding the address does, and promises nothing it cannot keep", () => {
    // The only server that passes the file on is the receiver's own, so hiding does not hide the address from them.
    expect(COPY.hide.hint).toMatch(/the server that passes the file on is theirs/iu);
    expect(COPY.hide.hint).toMatch(/could still find it/iu);
    expect(COPY.hide.hint).toMatch(/won't show it/iu);
    for (const text of [COPY.hide.label, COPY.hide.hint, COPY.hide.theirs]) {
      expect(text).not.toMatch(/\b(?:can't|cannot|won't|will not) (?:see|find|tell|learn|know)\b|anonymous|invisible|untraceable|private|safe from|completely|guarantee/iu);
    }
    // Short enough to read at the choose screen.
    expect(COPY.hide.hint.length).toBeLessThan(160);
  });

  it("never mentions a share or a request, which are other flows", () => {
    for (const key of ["expired", "used", "wrongWords", "mismatch", "invalid", "cancelled", "incomplete", "failed"] as const) {
      const { h1, body } = COPY.screens[key];
      expect(`${h1} ${body}`).not.toMatch(/\bshar(?:e|ed|ing)\b|\brequest\b/iu);
    }
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
