# FSWNENC2 encryption envelope

`FSWNENC2` is the successor to `FSWNENC1` (see [`ENCRYPTION.md`](./ENCRYPTION.md)).
It is a coordinated, wire-breaking change shared with the Stash implementation.
It exists to close one exposure: `FSWNENC1` is nonce-safe only under a fresh key
per envelope, so sealing many envelopes under one reused key (Stash's vault-key
mode) risks catastrophic AES-GCM nonce reuse after a birthday-bounded number of
envelopes. `FSWNENC2` derives a distinct AES key for every envelope, so the
counter-from-zero nonce is safe regardless of how the input key is managed.

Scheme name: `forgesworn-aes-256-gcm-chunked-v2`.

The cryptographic core (AES-256-GCM, 1 MiB records, per-record counter in the
nonce and the AAD, the canonical metadata, and the padding bucket) is unchanged
from `FSWNENC1`. Only two things change: the header gains a 32-byte salt, and
the AES key is derived rather than used directly.

## Clear header

The header is 56 bytes:

| Offset | Bytes | Meaning |
| --- | ---: | --- |
| 0 | 8 | ASCII `FSWNENC2` |
| 8 | 4 | Big-endian chunk size, currently 1 MiB |
| 12 | 4 | Big-endian authenticated-record count |
| 16 | 8 | Random nonce prefix |
| 24 | 32 | Key-derivation salt |

An encoder MUST fill the salt with 32 fresh cryptographically random bytes for
every envelope. The nonce-safety of the whole format depends on this: two
envelopes that reuse both the salt and the nonce prefix under the same input key
would reuse a `(key, nonce)` pair. The salt is public; it is not secret
material.

## Key derivation

Let `input_key` be the 32-byte key the application supplies (a fresh per-file
random key, or a long-lived vault key). The per-envelope AES key is:

```
envelope_key = HKDF-SHA256(
  ikm  = input_key,
  salt = the 32-byte header salt,
  info = "forgesworn-aes-256-gcm-chunked/v2",   // UTF-8, no NUL
  L    = 32,
)
```

`info` MUST be exactly those 33 UTF-8 bytes. Because a fresh salt yields a fresh
`envelope_key`, per-file and vault sealing are byte-identical in every respect
except the input key, and that difference never appears in the envelope. There
is no mode flag on the wire.

## Records

Identical to `FSWNENC1`, over `envelope_key` and the 56-byte header:

- The logical plaintext (`4-byte metadata length || canonical metadata JSON ||
  source || random padding`, padded to the bucket `P(L)`) is split into records
  of at most 1 MiB.
- Record `i` uses nonce `noncePrefix || uint32be(i)` and additional
  authenticated data `header || uint32be(i)` (60 bytes), and appends a 16-byte
  GCM tag.

The envelope is the header followed by each record's ciphertext and tag. The
canonical metadata rules, the padding bucket `P(L)`, and the enumerated RFC 2119
validation rules are exactly those of `FSWNENC1` in `ENCRYPTION.md`, with the
56-byte header substituted for the 24-byte header throughout the AAD.

## Versioning

The magic is the version field. An encoder writing `FSWNENC2` MUST use a fresh
random salt and a derived key as above. A decoder MUST read `FSWNENC2`,
`FSWNENC1` and legacy `WBLMENC1`, dispatching on the magic; a `FSWNENC2` decoder
reads the salt and derives the key, a `FSWNENC1`/`WBLMENC1` decoder uses the
supplied key directly against the 24-byte header. The three are not
interchangeable under a single tag, because the magic is inside the AAD.

The media type is unchanged from `FSWNENC1`: an implementation MUST write and
accept `application/vnd.forgesworn.encrypted`, and MUST still accept the legacy
`application/vnd.wildbloom.encrypted` on read. `FSWNENC2` changes the envelope
bytes, not the media type.

The writer flip does not migrate existing envelopes. At the flip, new envelopes
are written `FSWNENC2` while existing `FSWNENC1` and `WBLMENC1` envelopes are
read in place and never re-sealed. The shared-key exposure is therefore frozen
at the flip, since no further envelope is written under the reused-key
construction; re-sealing existing frames under `FSWNENC2` is an opt-in step
later, not a forced migration.

## Known-answer vectors

Test-only, public material. Both vectors share a fixed salt
`e0e1…ff` and nonce prefix `d0d1d2d3d4d5d6d7`, and the same source
`ForgeSworn envelope v2 known-answer vector\n` as `known-answer.txt`
(`text/plain`); they differ only in the input key, which proves the derivation
separates the two modes. Production MUST use a random salt.

[`test-vectors/fswnenc2-per-file.json`](../test-vectors/fswnenc2-per-file.json)
— per-file mode, input key `000102…1f`:

| Value | Expected result |
| --- | --- |
| Header | `4653574e454e43320010000000000001d0d1d2d3d4d5d6d7e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff` |
| Derived key | `bdb55fc25122432b360391f0a509632e465111e6c7afe49665a1486ee5b14fdf` |
| Record 0 tag | `2b866dbb96c57d8c0ff7eccb328c8f06` |
| Envelope bytes | `65608` |
| Envelope SHA-256 | `970edc2f54058343215cb447226c782b1e9b2943ef610790c20a2b3cde786e2d` |

[`test-vectors/fswnenc2-vault.json`](../test-vectors/fswnenc2-vault.json) —
vault mode, input key `404142…5f`:

| Value | Expected result |
| --- | --- |
| Derived key | `75a6809d23a3acac…` (distinct from per-file, same salt and nonce prefix) |
| Envelope SHA-256 | `93e54b2690d4fb818b9dfaa81011cc2a2415c83e21659b6b3fcd982f3838b2cb` |

Run `node scripts/fswnenc2-vector.mjs` to regenerate both, or
`npm run fswnenc2:vector`. `scripts/fswnenc2-vector.mjs` is the reference
encoder and decoder; `tests/fswnenc2.test.ts` checks the committed vectors are
reproducible, round-trip, separate the two modes, and reject a flipped tag.

## Status

Specified and vectored; not yet implemented in production. The production flip
(`FSWNENC2` dual-reading `FSWNENC1`) is a coordinated rollout across the
Wildbloom and Stash implementations. This document and its vectors are the
shared contract both build against.
