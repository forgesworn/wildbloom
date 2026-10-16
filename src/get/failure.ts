import { BlossomRetrievalError } from "../core/blossom.js";

/** What went wrong while pairing, in the page's terms. */
export type PairingFailure = "claim-refused" | "network" | "wrong-words" | "expired" | "cancelled";

/** What went wrong while fetching or opening the file. */
export type DownloadFailure = "missing" | "unavailable" | "damaged";

interface TransportLike {
  readonly name?: unknown;
  readonly kind?: unknown;
  readonly status?: unknown;
}

function asTransport(error: unknown): TransportLike | undefined {
  if (typeof error === "object" && error !== null && (error as TransportLike).name === "ForegatherTransportError") return error as TransportLike;
  return undefined;
}

/**
 * The pairing kit rejects a wrong secret with a plain string and a network
 * problem with a transport error or a TypeError, so structure tells them apart.
 * A refused claim is a 404 whether the link was used, stopped or never existed.
 */
export function classifyPairingFailure(error: unknown, claimed: boolean): PairingFailure {
  const transport = asTransport(error);
  if (transport) {
    if (transport.kind === "expired") return "expired";
    if (transport.kind === "cancelled") return "cancelled";
    if (!claimed && transport.kind === "http" && typeof transport.status === "number" && [403, 404, 409, 410].includes(transport.status)) {
      return "claim-refused";
    }
    return "network";
  }
  if (error instanceof TypeError || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "NetworkError"))) return "network";
  return claimed ? "wrong-words" : "network";
}

/** A missing object is told apart from damaged bytes; anything else means the storage is unreachable. */
export function classifyDownloadFailure(error: unknown, stage: "fetch" | "open"): DownloadFailure {
  if (stage === "open") return "damaged";
  if (error instanceof BlossomRetrievalError) {
    if (error.kind === "integrity") return "damaged";
    return error.status === 404 || error.status === 410 ? "missing" : "unavailable";
  }
  return "unavailable";
}
