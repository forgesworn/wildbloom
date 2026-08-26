export interface EventTemplate {
  readonly kind: number;
  readonly created_at: number;
  readonly tags: string[][];
  readonly content: string;
}

export interface SignedNostrEvent extends EventTemplate {
  readonly id: string;
  readonly pubkey: string;
  readonly sig: string;
}

export interface SignerPort {
  getPublicKey(): Promise<string>;
  signEvent(template: EventTemplate): Promise<SignedNostrEvent>;
}

export type NetworkProfile = "direct" | "tor";

export const WILDBLOOM_ENCRYPTION = "wildbloom-aes-256-gcm-chunked-v1" as const;
export const WILDBLOOM_ENCRYPTED_FILE_NAME = "wildbloom.wbenc" as const;
export const WILDBLOOM_ENCRYPTED_MIME_TYPE = "application/vnd.wildbloom.encrypted" as const;
export type EncryptionScheme = typeof WILDBLOOM_ENCRYPTION;

export interface BlobDescriptor {
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly type: string;
  readonly uploaded: number;
}

export interface InspectedFile {
  readonly file: File;
  readonly name: string;
  readonly extension: string;
  readonly sha256: string;
  readonly size: number;
  readonly type: string;
}

export interface ProtectedFile {
  readonly inspected: InspectedFile;
  readonly recoveryKey: string;
  readonly scheme: EncryptionScheme;
  readonly sourceName: string;
  readonly sourceSize: number;
  readonly sourceType: string;
}

export interface TorrentPlan {
  readonly torrentBytes: Uint8Array;
  readonly torrentBlob: Blob;
  readonly infoHash: string;
  readonly magnetUri: string;
  readonly name: string;
  readonly trackers: readonly string[];
  readonly webSeed: string;
}

export interface HybridPublication {
  readonly inspected: InspectedFile;
  readonly descriptor: BlobDescriptor;
  readonly torrent?: TorrentPlan;
  readonly encryption?: EncryptionScheme;
}

export interface ResolvedHybridEvent {
  readonly event: SignedNostrEvent;
  readonly url: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly size: number;
  readonly magnetUri?: string;
  readonly infoHash?: string;
  readonly trackers: readonly string[];
  readonly encryption?: EncryptionScheme;
  readonly name: string;
}

export interface RelayResult {
  readonly relay: string;
  readonly ok: boolean;
  readonly message: string;
}

export interface StopHandle {
  stop(): Promise<void>;
}
