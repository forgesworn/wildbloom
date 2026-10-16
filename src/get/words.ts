import wordListText from "./en-v1.txt?raw";

/** The shared 2,048-word list, vendored byte for byte; tests pin its SHA-256. */
export const WORD_LIST_TEXT: string = wordListText;
export const WORDS: readonly string[] = Object.freeze(wordListText.split("\n"));
const WORD_SET: ReadonlySet<string> = new Set(WORDS);

export const REQUIRED_WORDS = 4;

/** Lower-case, then split on runs of spaces, commas, full stops, hyphens and line breaks. */
export function parseWords(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[\s,.\-‐-―]+/u)
    .filter((word) => word.length > 0);
}

export function isKnownWord(word: string): boolean {
  return WORD_SET.has(word);
}

/** Optimal string alignment distance: an adjacent swap counts as one edit. */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) table[i]![0] = i;
  for (let j = 0; j < cols; j += 1) table[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(table[i - 1]![j]! + 1, table[i]![j - 1]! + 1, table[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, table[i - 2]![j - 2]! + 1);
      }
      table[i]![j] = value;
    }
  }
  return table[a.length]![b.length]!;
}

/**
 * The single list word within one edit of the input, else the single word
 * within two. More than one candidate at the nearest distance gives no
 * suggestion, because a wrong guess is worse than none.
 */
export function suggestWord(word: string): string | undefined {
  if (word.length < 2) return undefined;
  for (const limit of [1, 2]) {
    const matches = WORDS.filter((candidate) => Math.abs(candidate.length - word.length) <= limit && editDistance(word, candidate) <= limit);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  return undefined;
}

export type WordsCheck =
  | { readonly ok: true; readonly words: readonly string[]; readonly secret: string }
  | { readonly ok: false; readonly problem: "empty" }
  | { readonly ok: false; readonly problem: "count"; readonly count: number }
  | { readonly ok: false; readonly problem: "unknown"; readonly index: number; readonly word: string; readonly suggestion: string | undefined };

/** Local validation, run before anything is sent so a typo never spends the one attempt. */
export function checkWords(input: string): WordsCheck {
  const words = parseWords(input);
  if (words.length === 0) return { ok: false, problem: "empty" };
  if (words.length !== REQUIRED_WORDS) return { ok: false, problem: "count", count: words.length };
  const index = words.findIndex((word) => !isKnownWord(word));
  if (index >= 0) {
    const word = words[index]!;
    return { ok: false, problem: "unknown", index, word, suggestion: suggestWord(word) };
  }
  return { ok: true, words, secret: words.join(" ") };
}

/** Replace one word in the user's text and return the tidy four-word form. */
export function applySuggestion(input: string, index: number, replacement: string): string {
  const words = parseWords(input);
  words[index] = replacement;
  return words.join(" ");
}
