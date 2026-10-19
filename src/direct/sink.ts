import { decryptPrivacyEnvelope, sha256Hex } from "../core/crypto.js";
import type { DirectSink } from "./transfer.js";

export interface MemorySinkOptions {
  /** The `wbk1_` key the sender put in its answer. */
  readonly key: string;
  /** What the sender said it would send. The envelope's own metadata must match it exactly. */
  readonly manifest: { readonly name: string; readonly size: number; readonly type: string };
  /** The envelope length the manifest implies. */
  readonly envelopeBytes: number;
}

export interface MemorySink extends DirectSink {
  /** The verified file. It is undefined until `end` has resolved, so nothing can be offered for saving before then. */
  readonly file: File | undefined;
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * A sink for a browser receiver (the test receiver, and `/get` direct mode
 * later): it holds the envelope in memory, and on `end` opens it with the page's
 * reader, which authenticates every record and checks the record count and
 * padding against the header. It then checks the metadata against the manifest
 * and the plaintext size and SHA-256 against END. Only then does `file` exist.
 */
export function createMemorySink(options: MemorySinkOptions): MemorySink {
  let parts: Uint8Array[] | undefined = [];
  let held = 0;
  let file: File | undefined;
  return {
    get file(): File | undefined {
      return file;
    },
    async write(bytes): Promise<void> {
      if (!parts) throw new Error("The sink has been closed.");
      if (held + bytes.length > options.envelopeBytes) throw new Error("More bytes than the envelope holds.");
      parts.push(bytes);
      held += bytes.length;
    },
    async end(end): Promise<void> {
      if (!parts || held !== options.envelopeBytes) throw new Error("The envelope is not complete.");
      const envelope = new Blob(parts as BlobPart[]);
      parts = undefined;
      const opened = await decryptPrivacyEnvelope(envelope, options.key);
      const { manifest } = options;
      if (opened.name !== manifest.name || opened.type !== manifest.type || opened.size !== manifest.size) {
        throw new Error("The file inside is not the one the manifest named.");
      }
      if (opened.size !== end.size) throw new Error("The file's size is not the size END gave.");
      if ((await sha256Hex(opened)) !== toHex(end.sha256)) throw new Error("The file's SHA-256 is not the one END gave.");
      file = opened;
    },
    async abort(): Promise<void> {
      parts = undefined;
      file = undefined;
    },
  };
}
