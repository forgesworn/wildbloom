/**
 * Strict reading of the small flat JSON objects the request protocol uses,
 * matching how the Rust reference (serde with `deny_unknown_fields`) reads them:
 * a repeated member is an error, a number must be written as a plain whole
 * number, and a string cannot hold a lone surrogate. `JSON.parse` alone gets
 * all three wrong, so the page reads members from the source text.
 */

export interface FlatMember {
  readonly key: string;
  /** The value exactly as written, without surrounding space. */
  readonly raw: string;
}

const U64_MAX = 18_446_744_073_709_551_615n;
const WHOLE_NUMBER = /^(?:0|[1-9][0-9]*)$/u;

/**
 * The top-level members of a JSON object, in source order and including any
 * repeats, or undefined when the text is not one valid JSON object.
 */
export function flatMembers(text: string): FlatMember[] | undefined {
  if (!text.replace(/^[ \t\n\r\f]+/u, "").startsWith("{")) return undefined;
  try {
    JSON.parse(text);
  } catch {
    return undefined;
  }
  // The text is valid JSON from here, so the scan below can stay simple.
  const members: FlatMember[] = [];
  let index = text.indexOf("{") + 1;
  const skipSpace = (): void => {
    while (index < text.length && " \t\n\r".includes(text[index]!)) index += 1;
  };
  const readString = (): string => {
    const start = index;
    index += 1;
    while (text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
    index += 1;
    return text.slice(start, index);
  };
  for (;;) {
    skipSpace();
    if (text[index] === "}") return members;
    if (text[index] === ",") {
      index += 1;
      skipSpace();
    }
    const key = JSON.parse(readString()) as string;
    skipSpace();
    index += 1; // the colon
    skipSpace();
    const start = index;
    let depth = 0;
    while (index < text.length) {
      const character = text[index]!;
      if (character === '"') {
        readString();
        continue;
      }
      if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        if (depth === 0) break;
        depth -= 1;
      } else if (character === "," && depth === 0) break;
      index += 1;
    }
    members.push({ key, raw: text.slice(start, index).trimEnd() });
  }
}

/** True when every member name is one of `names` and each appears once, in any order. */
export function hasExactMembers(members: readonly FlatMember[], names: readonly string[]): boolean {
  const seen = members.map((member) => member.key);
  return seen.length === names.length && new Set(seen).size === seen.length && names.every((name) => seen.includes(name));
}

export function member(members: readonly FlatMember[], name: string): string | undefined {
  return members.find((candidate) => candidate.key === name)?.raw;
}

/** A JSON string value, or undefined for anything else (including a string a Rust `String` could not hold). */
export function jsonString(raw: string | undefined): string | undefined {
  if (raw === undefined || !raw.startsWith('"')) return undefined;
  const value = JSON.parse(raw) as string;
  return /\p{Surrogate}/u.test(value) ? undefined : value;
}

/** A whole number written without sign, fraction, exponent or leading zero, within u64. */
export function jsonU64(raw: string | undefined): bigint | undefined {
  if (raw === undefined || !WHOLE_NUMBER.test(raw)) return undefined;
  const value = BigInt(raw);
  return value > U64_MAX ? undefined : value;
}
