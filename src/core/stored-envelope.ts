import {assertPrototypeTransferSize} from './security.js';

/** Structural checks only: the originating application must verify authentication and recovery. */
export async function existingEncryptedFile(file: File, signal?: AbortSignal): Promise<File> {
  assertPrototypeTransferSize(file.size);
  signal?.throwIfAborted();
  if (file.size < 65_608) throw new Error('Choose an existing encrypted FSWNENC2 file, not a bare account record.');
  const header = new Uint8Array(await file.slice(0, 56).arrayBuffer());
  signal?.throwIfAborted();
  const view = new DataView(header.buffer);
  const count = view.getUint32(12, false);
  const plaintext = file.size - 56 - count * 16;
  if (new TextDecoder().decode(header.subarray(0, 8)) !== 'FSWNENC2'
    || view.getUint32(8, false) !== 1_048_576 || count < 1 || count > 258
    || plaintext < 65_536 || plaintext <= (count - 1) * 1_048_576 || plaintext > count * 1_048_576) {
    throw new Error('Invalid FSWNENC2 encrypted-file header or length.');
  }
  return new File([file], 'encrypted-file.fswnenc', {type: 'application/vnd.forgesworn.encrypted', lastModified: 0});
}
