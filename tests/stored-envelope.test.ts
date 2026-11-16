import {describe, expect, it} from 'vitest';
import {decryptPrivacyEnvelope, encryptPrivacyEnvelope, sha256Hex} from '../src/core/crypto.js';
import {existingEncryptedFile} from '../src/core/stored-envelope.js';
import {fetchPool, parsePoolNodes, preparePool, resolvePoolReceipt, signPool, uploadPool} from '../src/core/pool.js';
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure';
import type {SignerPort} from '../src/core/types.js';

describe('explicit storage of an existing encrypted file', () => {
  it('verifies uploads and recovers the exact existing envelope from all six 2-of-4 pairs without its original signer', async () => {
    const source = new File(['a root-protected collection'], 'accounts.json');
    const envelope = await encryptPrivacyEnvelope(source);
    const encrypted = await existingEncryptedFile(envelope.file);
    const nodes = parsePoolNodes(Array.from({length: 4}, (_, i) => `https://n${i}.example site-${i}`).join('\n'), 'direct');
    const prepared = await preparePool(encrypted, 'erasure', nodes, 2, 4, 1, 'direct');
    const key = new Uint8Array(32).fill(42);
    const signer: SignerPort = {getPublicKey: async () => getPublicKey(key), signEvent: async t => finalizeEvent(t, key)};
    const receipt = await signPool(prepared.manifest, signer, getPublicKey(key));
    const stored = new Map<string, Blob>();
    let surviving: Set<string> | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (surviving && !surviving.has(url.origin)) return new Response(null, {status: 503});
      if (init?.method === 'PUT') {
        const file = init.body as File;
        const hash = await sha256Hex(file);
        const location = `${url.origin}/${hash}`;
        stored.set(location, file);
        return Response.json({url: location, sha256: hash, size: file.size, type: 'application/octet-stream', uploaded: 1}, {status: 201});
      }
      const blob = stored.get(url.href);
      return blob ? new Response(blob, {headers: {'Content-Length': String(blob.size)}}) : new Response(null, {status: 404});
    };
    expect((await uploadPool(prepared, receipt, signer, receipt.event.pubkey, {fetchImpl})).protected).toBe(true);
    const freshReceipt = resolvePoolReceipt(JSON.stringify(receipt.event), 'direct');
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
      surviving = new Set([a, b].map(i => new URL(freshReceipt.manifest.parts[i]!.targets[0]!.origin).origin));
      const recovered = await fetchPool(freshReceipt, {fetchImpl});
      expect(await recovered.arrayBuffer()).toEqual(await encrypted.arrayBuffer());
      expect(await (await decryptPrivacyEnvelope(recovered, envelope.recoveryKey)).text()).toBe(await source.text());
    }
    surviving = new Set([new URL(freshReceipt.manifest.parts[0]!.targets[0]!.origin).origin]);
    await expect(fetchPool(freshReceipt, {fetchImpl})).rejects.toThrow();
  });
  it('keeps the exact ciphertext without inventing another recovery key', async () => {
    const {file} = await encryptPrivacyEnvelope(new File(['a test collection'], 'accounts.json'));
    const stored = await existingEncryptedFile(file);
    expect(await stored.arrayBuffer()).toEqual(await file.arrayBuffer());
    expect(stored.name).toBe('encrypted-file.fswnenc');
    expect(stored.type).toBe('application/vnd.forgesworn.encrypted');
  });
  it('rejects plaintext, truncation and impossible headers', async () => {
    await expect(existingEncryptedFile(new File(['nstw1:abc'], 'account.nstw'))).rejects.toThrow();
    const {file} = await encryptPrivacyEnvelope(new File(['test'], 'source.txt'));
    const bytes = new Uint8Array(await file.arrayBuffer());
    for (const at of [0, 8, 12]) {
      const changed = bytes.slice(); changed[at] = changed[at]! ^ 1;
      await expect(existingEncryptedFile(new File([changed], 'wrong.bin'))).rejects.toThrow();
    }
    await expect(existingEncryptedFile(new File([bytes.subarray(0, 60)], 'short.bin'))).rejects.toThrow();
  });
  it('cancels preparation when consent is withdrawn', async () => {
    const {file} = await encryptPrivacyEnvelope(new File(['test'], 'source.txt'));
    const controller = new AbortController(); controller.abort();
    await expect(existingEncryptedFile(file, controller.signal)).rejects.toThrow();
  });
});
