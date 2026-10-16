import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applySuggestion, checkWords, editDistance, isKnownWord, parseWords, suggestWord, WORD_LIST_TEXT, WORDS } from "../src/get/words.js";

describe("the word list", () => {
  it("is the shared en-v1 list, byte for byte", () => {
    expect(createHash("sha256").update(WORD_LIST_TEXT).digest("hex")).toBe("0334930ebdfbc76e81ec914515d7567ca85738a6bf3069249d97df951d44661c");
    expect(WORDS).toHaveLength(2048);
    expect(new Set(WORDS).size).toBe(2048);
    expect(WORDS.every((word) => /^[a-z]+$/u.test(word))).toBe(true);
  });
});

describe("word parsing", () => {
  it("lower-cases and splits on spaces, commas, full stops, hyphens and line breaks", () => {
    expect(parseWords("Orbit, Lemon. candle-frost")).toEqual(["orbit", "lemon", "candle", "frost"]);
    expect(parseWords("  orbit\n\nlemon \t frost -- stone ")).toEqual(["orbit", "lemon", "frost", "stone"]);
    expect(parseWords("orbit\u2013lemon\u2014frost")).toEqual(["orbit", "lemon", "frost"]);
    expect(parseWords("")).toEqual([]);
    expect(parseWords(" ,.- ")).toEqual([]);
  });

  it("recognises list words only", () => {
    expect(isKnownWord("orbit")).toBe(true);
    expect(isKnownWord("orbitx")).toBe(false);
    expect(isKnownWord("Orbit")).toBe(false);
  });
});

describe("edit distance and suggestions", () => {
  it("counts an adjacent swap as one edit", () => {
    expect(editDistance("frost", "frots")).toBe(1);
    expect(editDistance("lemon", "lemno")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("kitten", "sitting")).toBe(3);
  });

  it("suggests the single nearby word and stays quiet when it is ambiguous or far", () => {
    expect(suggestWord("frots")).toBe("frost");
    expect(suggestWord("lemmon")).toBe("lemon");
    expect(suggestWord("candel")).toBe("cancel");
    expect(suggestWord("canxxl")).toBeUndefined();
    expect(suggestWord("zzzzzzzz")).toBeUndefined();
    expect(suggestWord("a")).toBeUndefined();
  });
});

describe("local word checks", () => {
  it("passes four list words and joins them with single spaces", () => {
    expect(checkWords("Orbit, lemon.  frost-stone")).toEqual({ ok: true, words: ["orbit", "lemon", "frost", "stone"], secret: "orbit lemon frost stone" });
  });

  it("reports empty input, a wrong count and the first unknown word", () => {
    expect(checkWords("  ")).toEqual({ ok: false, problem: "empty" });
    expect(checkWords("orbit lemon")).toEqual({ ok: false, problem: "count", count: 2 });
    expect(checkWords("orbit lemon frost stone river")).toEqual({ ok: false, problem: "count", count: 5 });
    expect(checkWords("orbit lemon frots stone")).toEqual({ ok: false, problem: "unknown", index: 2, word: "frots", suggestion: "frost" });
    expect(checkWords("orbit lemon candel frost")).toEqual({ ok: false, problem: "unknown", index: 2, word: "candel", suggestion: "cancel" });
    expect(checkWords("orbit lemon qqqqqq frost")).toEqual({ ok: false, problem: "unknown", index: 2, word: "qqqqqq", suggestion: undefined });
  });

  it("checks the count before the spelling, so a short entry is told how many it needs", () => {
    expect(checkWords("orbit zzzz")).toEqual({ ok: false, problem: "count", count: 2 });
  });

  it("replaces one word in place and tidies the separators", () => {
    expect(applySuggestion("Orbit, lemon. frots-stone", 2, "frost")).toBe("orbit lemon frost stone");
  });
});
