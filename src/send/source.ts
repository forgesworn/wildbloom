import { sanitiseFileName } from "../core/security.js";
import { DISGUISING_CHARACTERS } from "../direct/messages.js";

/**
 * Brings a phone's file name and type within what Drop's reader accepts before
 * anything is encrypted. The page writes the name and type into the envelope's
 * private metadata, and Drop (Rust) refuses an envelope whose metadata is not a
 * fixed point of its own sanitiser, so an odd name must be repaired here rather
 * than turn into "couldn't be opened" on the other side.
 */

const FALLBACK_TYPE = "application/octet-stream";
const PRINTABLE_ASCII = /^[ -~]*$/u;

/** Replaces a lone surrogate with U+FFFD, as Rust's UTF-8 decoding would; JSON cannot carry one there. */
export function wellFormed(text: string): string {
  return text.replace(/\p{Surrogate}/gu, "�");
}

/**
 * The type, lower-cased, or the generic one when it is empty, over 255 units or
 * anything but printable ASCII. Case folding outside ASCII can differ between
 * browsers and Rust, so such a type is never trusted to round-trip.
 */
export function safeMediaType(type: string): string {
  const lowered = type.toLowerCase();
  return lowered.length === 0 || lowered.length > 255 || !PRINTABLE_ASCII.test(lowered) ? FALLBACK_TYPE : lowered;
}

/**
 * The name without the characters that change how it is drawn or cannot be seen (see `DISGUISING_CHARACTERS`),
 * so that a name like `invoice` + U+202E + `fdp.terminal`, which is drawn as `invoicelanimret.pdf`, is sent as
 * the plain name it is made of, and the receiver is never shown an extension that is not the real one.
 */
export function plainName(name: string): string {
  return name.replace(DISGUISING_CHARACTERS, "");
}

/** The file as it will be encrypted: same bytes (no copy), a name and type Drop will read. */
export function prepareSource(file: File): File {
  return new File([file], sanitiseFileName(wellFormed(plainName(file.name))), { type: safeMediaType(file.type), lastModified: 0 });
}
