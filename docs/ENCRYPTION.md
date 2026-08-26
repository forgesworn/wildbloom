# Encryption envelope

Wildbloom's current private payload format is
`wildbloom-aes-256-gcm-chunked-v1`.

It is a versioned application envelope built from standard Web Crypto
AES-256-GCM. The format itself is new and must receive independent review
before a public production release.

## Key and metadata

- Each encryption creates a fresh random 32-byte key.
- Recovery keys are encoded as `wbk1_` followed by unpadded base64url.
- The source filename, MIME type and exact byte count live inside the encrypted
  first record.
- The public payload always uses `wildbloom.wbenc` and
  `application/vnd.wildbloom.encrypted`.
- The key is never written to Nostr, Blossom, torrent metadata, local storage,
  session storage or IndexedDB.

## Binary format

The 24-byte clear header is:

| Offset | Bytes | Meaning |
| --- | ---: | --- |
| 0 | 8 | ASCII `WBLMENC1` |
| 8 | 4 | Big-endian chunk size, currently 1 MiB |
| 12 | 4 | Big-endian authenticated-record count |
| 16 | 8 | Random nonce prefix |

Each record encrypts at most 1 MiB and appends a 16-byte GCM authentication
tag. The 12-byte nonce is the random eight-byte prefix followed by the
big-endian record counter. The additional authenticated data is the complete
clear header followed by that same counter. This binds the version, chunk
size, record count, nonce prefix, record order and record position.

The encrypted logical plaintext is:

1. four-byte metadata JSON length;
2. canonical JSON containing `name`, `size` and `type`;
3. source file bytes;
4. cryptographically random padding.

Payloads up to 64 KiB are padded to 64 KiB. Payloads below 1 MiB use the next
power-of-two bucket. Larger payloads use the next 1 MiB boundary. Padding
reduces exact-size leakage but does not conceal the approximate size class.

## Validation

Decryption rejects unknown magic, versions represented by other magic,
unexpected chunk sizes, impossible record counts or lengths, malformed keys,
non-canonical metadata, excessive source sizes, altered headers, reordered
records, modified ciphertext, wrong keys and invalid padding buckets.

Hashing, encryption and decryption accept an abort signal and check it between
bounded chunks. File, endpoint and profile changes cancel the active local
operation; a completion from an older state revision is discarded rather than
restoring stale recovery material or a save link. Web Crypto cannot interrupt
an individual in-flight primitive, so cancellation takes effect at the next
one-MiB record boundary.

The encrypted Blob's SHA-256 and signed byte count are verified before
decryption. GCM authentication is then verified independently for every
record. Plaintext is offered for saving only after every record succeeds.

## Residual risks

- JavaScript and Web Crypto operate inside the browser process. A compromised
  browser, extension or page can read plaintext and keys.
- GCM safety depends on unique nonces for a key. Wildbloom uses a fresh random
  key and nonce prefix for every envelope and refuses more than 258 records.
- No password KDF is involved. The recovery key has full cryptographic entropy
  and must not be replaced with a human password.
- Padding reveals a size bucket, and traffic volume can reveal more.
- This format has automated vectors and tamper tests but no independent audit
  yet.
