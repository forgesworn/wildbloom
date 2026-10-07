import { fetchVerifiedBlob } from "./blossom.js";
import { sha256Hex } from "./crypto.js";
import { assertHex64, normaliseBlossomServer } from "./security.js";
import {
  ServiceRequestError,
  integer,
  record,
  requestJson,
  text,
  type Buyer,
  type ServiceOptions,
} from "./services-http.js";
import type { ResolvedHybridEvent } from "./types.js";

export type AuditStage = "challenge" | "response" | "retrieval" | "digest";
export class StorageAuditError extends Error {
  constructor(readonly stage: AuditStage, message: string) {
    super(message);
    this.name = "StorageAuditError";
  }
}
export function auditFailure(error: unknown): { stage: string; reason: string } {
  if (error instanceof ServiceRequestError)
    return { stage: error.code, reason: error.message };
  if (error instanceof StorageAuditError)
    return { stage: error.stage, reason: error.message };
  return { stage: "unknown", reason: "Storage audit could not be completed." };
}

export interface StorageAudit {
  version: 1;
  origin: string;
  sha256: string;
  size: number;
  nonce: string;
  digest: string;
  verifiedAt: number;
  scope: "full-read retrievability";
}
export async function challengeDigest(
  blob: Blob,
  nonce: string,
  signal?: AbortSignal,
): Promise<string> {
  const hex = assertHex64(nonce, "Challenge nonce");
  const challenge = Uint8Array.from(hex.match(/../gu)!, (byte) =>
    parseInt(byte, 16),
  );
  const size = new ArrayBuffer(8);
  new DataView(size).setBigUint64(0, BigInt(blob.size));
  return sha256Hex(
    new Blob(["wildbloom.storage-proof.v1\n", challenge, size, blob]),
    signal,
  );
}
export async function auditStoredBlob(
  file: ResolvedHybridEvent,
  origin: string,
  buyer: Buyer,
  options: ServiceOptions = {},
): Promise<StorageAudit> {
  const base = `${normaliseBlossomServer(origin, options.profile ?? "direct")}/`;
  const nonce = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  let stage: AuditStage = "challenge";
  try {
    const response = await requestJson(
      base,
      "/storage/v1/proof",
      { sha256: file.sha256, nonce },
      buyer,
      { ...options, timeoutMs: options.timeoutMs ?? 300000 },
    );
    stage = "response";
    const proof = record(response);
    if (
      proof.version !== 1 ||
      proof.sha256 !== file.sha256 ||
      proof.nonce !== nonce ||
      integer(proof.size) !== file.size
    )
      throw new Error("Storage proof does not match the fresh challenge.");
    const digest = assertHex64(text(proof.digest, 64), "Storage proof digest");
    // Never trust a server's own hash assertion. Verify all retrieved bytes against
    // the owner's signed file/part commitment, then recompute the nonce-bound scan.
    stage = "retrieval";
    const bytes = await fetchVerifiedBlob(file, {
      ...options,
      replicaServer: base,
    });
    stage = "digest";
    if ((await challengeDigest(bytes, nonce, options.signal)) !== digest)
      throw new Error("Storage proof failed independent byte verification.");
    options.signal?.throwIfAborted();
    return {
      version: 1,
      origin: base,
      sha256: file.sha256,
      size: file.size,
      nonce,
      digest,
      verifiedAt: Math.floor(Date.now() / 1000),
      scope: "full-read retrievability",
    };
  } catch (error) {
    if (error instanceof ServiceRequestError) throw error;
    const reasons: Record<AuditStage, string> = {
      challenge: "Could not prepare or request the storage challenge.",
      response: "Node proof is invalid or does not match the fresh challenge.",
      retrieval: "Independent retrieval failed; the stored bytes could not be fetched and verified.",
      digest: "Storage proof failed independent byte verification.",
    };
    throw new StorageAuditError(stage, reasons[stage]);
  }
}
