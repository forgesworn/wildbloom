# Encryption envelope

Wildbloom's current private payload format is
`wildbloom-aes-256-gcm-chunked-v1`.

It is a versioned application envelope built from standard Web Crypto
AES-256-GCM. The format has had an independent standards review, recorded in
[`ENVELOPE-REVIEW.md`](./ENVELOPE-REVIEW.md); a third-party cryptographic audit
is still outstanding before it should be treated as a settled public standard.

## Key and metadata

- Each encryption creates a fresh random 32-byte key.
- Recovery keys are encoded as `wbk1_` followed by canonical unpadded
  base64url. The decoder re-encodes and compares the value so alternate final
  characters that decode to the same 256 bits are rejected.
- The source filename, MIME type and exact byte count live inside the encrypted
  first record.
- The public payload always uses `wildbloom.wbenc` and
  `application/vnd.forgesworn.encrypted`. A decoder MUST also accept the legacy
  media type `application/vnd.wildbloom.encrypted` on read.
- The key is never written to Nostr, Blossom, torrent metadata, cookies, local
  or session storage, IndexedDB or Cache Storage, and no service worker is
  registered.
- Random bytes are filled directly into their destination buffer. Mutable raw
  key, source-chunk and private-metadata buffers are overwritten as soon as
  their operation finishes or fails.

## Binary format

The 24-byte clear header is:

| Offset | Bytes | Meaning |
| --- | ---: | --- |
| 0 | 8 | ASCII `FSWNENC1`. A decoder MUST also read the legacy magic `WBLMENC1` |
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

## Canonical metadata

The metadata is the exact UTF-8 bytes of a JSON object with these three keys, in
this order, and no insignificant whitespace:

```
{"name":<name>,"size":<size>,"type":<type>}
```

An encoder MUST produce, and a decoder MUST reject anything other than, this
canonical form. Specifically:

- `size` MUST be the source byte count as a base-10 JSON integer: no sign, no
  exponent, no leading zeros.
- `name` MUST be the source filename after, in order: Unicode NFC
  normalisation; removal of code points `U+0000`–`U+001F` and `U+007F`; mapping
  each of `< > : " | ? *` to `_`; removal of leading `.`; trimming of leading
  and trailing whitespace; replacement by `blob.bin` if the result is empty; and
  truncation to at most 180 UTF-16 code units. The stored `name` MUST be a fixed
  point of this function; a decoder recomputes it and rejects a mismatch.
- `type` MUST be the source media type lower-cased, with `U+0000`–`U+001F` and
  `U+007F` removed, truncated to at most 255 characters, and replaced by
  `application/octet-stream` if empty.
- String values MUST use the minimal JSON escaping profile: only `"`, `\`, and
  the control code points `U+0000`–`U+001F` are escaped, using the two-character
  short escapes where they exist and `\u00XX` otherwise; `/` is NOT escaped; all
  other code points are emitted as literal UTF-8. This is the profile a
  second implementation must match byte-for-byte, so a library that escapes
  non-ASCII as `\uXXXX` or escapes `/` is non-conformant.

## Padding bucket

Let `L = 4 + len(metadata) + size` be the logical plaintext length before
padding, where `len(metadata)` is the canonical metadata byte length and `size`
is the source byte count. The padded plaintext length `P(L)` is exactly:

- `L ≤ 65536` → `65536`;
- `65536 < L ≤ 1048576` → `2 ** ceil(log2(L))`;
- `L > 1048576` → `ceil(L / 1048576) * 1048576`.

`L = 1048576` falls in the middle branch and pads to `2**20 = 1048576`. A
decoder MUST recompute `P` from the recovered logical length and reject an
envelope whose decrypted plaintext length differs.

## Versioning and legacy read

The magic is the version field. A conformant encoder MUST write `FSWNENC1`. A
conformant decoder MUST read both `FSWNENC1` and the legacy `WBLMENC1`, and MUST
accept both the current media type `application/vnd.forgesworn.encrypted` and
the legacy `application/vnd.wildbloom.encrypted`. `FSWNENC1` and `WBLMENC1` name
byte-identical cryptography; only the eight magic bytes differ, and because the
magic is inside the AAD an existing envelope's magic cannot be altered without
breaking its tag. The legacy read is retained for envelopes written before the
rename and carries a deprecation horizon rather than a permanent guarantee.

The next version, `FSWNENC2`, is a coordinated change with the Stash
implementation that shares this format. It adds a 32-byte random salt to the
clear header and derives the AES key per envelope with
`HKDF-SHA256(ikm = the envelope key, salt = the header salt, info =
"forgesworn-aes-256-gcm-chunked/v2")`, under the same header layout for both
per-file and vault-key sealing. This closes the shared-key nonce-reuse exposure
described in the independent review; it does not affect Wildbloom, which always
uses a fresh per-file key. `FSWNENC2` will dual-read `FSWNENC1` and carry the
scheme name `forgesworn-aes-256-gcm-chunked-v2`. It is specified, with its own
known-answer vectors, in the review below before any implementation ships.

## Published known-answer vectors

[`test-vectors/encryption-v2.json`](../test-vectors/encryption-v2.json) is the
language-neutral one-record interoperability vector for this format, carrying
the current magic `FSWNENC1`. It uses the public, test-only key `000102...1f`,
nonce prefix `a0a1a2a3a4a5a6a7` and source text
`Wildbloom v1 known-answer vector` followed by LF. Its padding is
deliberately deterministic: byte `i` is `(i * 73 + 41) mod 256` before the
metadata and source overwrite. Production encryption continues to use fresh random padding,
keys and nonce prefixes.

The one-record vector has these fixed results:

| Value | Expected result |
| --- | --- |
| Recovery key | `wbk1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8` |
| Header | `4653574e454e43310010000000000001a0a1a2a3a4a5a6a7` |
| Authentication tag | `e19911d800ec456e3d0cc69e025f1369` |
| Envelope bytes | `65576` |
| Envelope SHA-256 | `692f616773a25c68f78382a3a24d62a34a81d0f29c38bd7fc138f369b6adbf30` |

The legacy `WBLMENC1` one-record envelope
([`test-vectors/encryption-v1.json`](../test-vectors/encryption-v1.json)) is
retained as the read-only compatibility vector. Its header is
`57424c4d454e43310010000000000001a0a1a2a3a4a5a6a7`, tag
`5329a95ec40f523cad9dcaf35f3fb572`, envelope SHA-256
`fca9348751d30b2e2461f03612ce7b8a85c702513faf1b3ae4b38ca882a45d23`. The bytes
differ from the `FSWNENC1` vector only in the eight magic bytes, which the AAD
authenticates, so the two are not interchangeable under a single tag.

[`test-vectors/encryption-v2-two-records.json`](../test-vectors/encryption-v2-two-records.json)
carries the current magic `FSWNENC1` and crosses the one-MiB
authenticated-record boundary. It generates a
1,048,613-byte source where byte `i` is `(i * 29 + 7) mod 256`, uses the public
test-only key `202122...3f`, and pads the logical plaintext to exactly two MiB.
The JSON records each record's nonce, additional authenticated data, plaintext
and ciphertext hashes and authentication tag.

| Value | Expected result |
| --- | --- |
| Recovery key | `wbk1_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8` |
| Header | `4653574e454e43310010000000000002b0b1b2b3b4b5b6b7` |
| Record 0 nonce | `b0b1b2b3b4b5b6b700000000` |
| Record 0 tag | `0ad51ff3f61dc22cfc0922477d351b91` |
| Record 1 nonce | `b0b1b2b3b4b5b6b700000001` |
| Record 1 tag | `1da99d3de654c400f176660254a242ae` |
| Envelope bytes | `2097208` |
| Envelope SHA-256 | `7065ed8c463bf377f94411db47bb10f76f012dc0bbef5ee6151b2f70113e8b09` |

Run `npm run encryption:vector` to regenerate both the current `FSWNENC1`
envelopes and the legacy `WBLMENC1` envelopes with Node's independent
AES-256-GCM implementation and compare every intermediate value with the JSON
contracts. The unit suite then feeds those independently
generated bytes into Wildbloom's production Web Crypto decryption. The hosted
production-browser journey rejects a wrong key without exposing a save link,
then recovers the one- and two-record vectors in system Chromium on Windows,
Linux and macOS, Playwright Firefox on Linux and Playwright WebKit on macOS. Branded Firefox
also recovers the one-record vector. The vector keys are public test material
and must never protect real content.

## Validation

A conformant decoder MUST reject an envelope, before offering any plaintext, in
each of these cases. Each maps to a published negative vector.

1. The magic is neither `FSWNENC1` nor the legacy `WBLMENC1`.
2. The clear chunk size is not the expected 1 MiB.
3. The record count is zero, or exceeds the maximum reachable count derived from
   the file-size and chunk-size limits.
4. The envelope length is not consistent with the header's record count and
   chunk size (a short or over-long body).
5. Any record's GCM authentication tag fails under the AAD built from the actual
   header bytes and that record's counter (this MUST subsume altered headers,
   reordered or duplicated records, modified ciphertext and a wrong key, because
   all of them are authenticated).
6. The recovered metadata is not the canonical form defined above (wrong keys,
   key order, whitespace, escaping, or a `name`/`type` that is not a fixed point
   of its normalisation).
7. The decrypted plaintext length is not the padding bucket `P(L)` for the
   recovered logical length `L`.
8. The recovered `size` exceeds the maximum source size.
9. The recovery key is not canonical unpadded base64url for exactly 32 bytes
   (the decoder re-encodes and compares).

There is no partial acceptance: a decoder MUST NOT surface any plaintext, or a
save link, until every record has authenticated and every check above has
passed.

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
- Overwriting mutable buffers reduces their lifetime but cannot guarantee
  process-wide zeroisation: browser internals, immutable strings and Blob/File
  implementations may retain copies outside JavaScript's control.
- GCM safety depends on unique nonces for a key. Wildbloom uses a fresh random
  key and nonce prefix for every envelope and refuses more than 258 records.
- No password KDF is involved. The recovery key has full cryptographic entropy
  and must not be replaced with a human password.
- Padding reveals a size bucket, and traffic volume can reveal more.
- This format has published one- and two-record known-answer vectors, in-code
  tamper tests, and an independent standards review
  ([`ENVELOPE-REVIEW.md`](./ENVELOPE-REVIEW.md)). Language-neutral negative
  vectors and a third-party cryptographic audit are still outstanding.
