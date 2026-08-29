# Independent review: the encryption envelope

This is the independent review of the shared encryption envelope required by
§E of the joint core contract (`CORE-CONTRACT-0.2`, signed by both owners
2026-08-28 / 2026-08-29). It reviews `wildbloom-aes-256-gcm-chunked-v1`
(magic `FSWNENC1`, media type `application/vnd.forgesworn.encrypted`) as a
candidate published standard: could an independent engineer implement it
byte-for-byte from the written spec alone, interop with the reference, and does
it survive an adversary.

Scope: the envelope format only. The Blossom storage layer, the ForgeSworn Link
transport, and the Nostr layer are reviewed separately.

Date: 2026-08-29.

## Verdict

**The cryptography is sound; the format is not yet a settled standard.** The
AEAD construction defeats truncation, reordering, duplication and
cross-envelope splicing, and that part is standard-worthy. What is missing is
standard-grade packaging: the spec had drifted from the code, "canonical JSON"
and the padding function were under-specified, there was no normative
(MUST / MUST NOT) language, and there were no shareable negative vectors. One
finding is a genuine cryptographic exposure in shared-key (vault) mode, which
has an agreed fix (`FSWNENC2`).

## Findings

Severity: **blocker** stops interop or is a live security issue; **major** is a
real gap a standard must close; **minor** is a tightening.

### Cryptographic soundness

- **[major → agreed fix] Shared-key (vault) nonce reuse.** The nonce is an
  8-byte random prefix plus a per-record counter that restarts at zero, so the
  format is nonce-safe only under a *fresh key per envelope*. Under a reused
  vault key, prefix collision is birthday-bounded: at NIST's 2⁻³² target the
  ceiling is ~2¹⁶·⁵ ≈ 93,000 envelopes under one key, and a repeated prefix is
  catastrophic GCM nonce reuse. Wildbloom is unaffected (it always uses a fresh
  per-file key); Stash's vault-key sealing (`frame::seal` takes the vault key
  directly as the AES key) has exactly this exposure. **Fix: `FSWNENC2`** — see
  below. Both owners have confirmed the direction.
- **[good] AAD binding.** Header (magic, chunk size, record count, nonce prefix)
  plus the per-record counter as AAD authenticates version, record order and
  record position, defeating truncation, reorder, duplication and splicing.
- **[good] Post-authentication metadata read.** The inner metadata length is
  read only from already-authenticated plaintext, so there is no pre-auth
  length-trust or allocation vector.
- **[minor] The record-count cap is stated as 258 on nonce-safety grounds.** The
  reachable maximum under the 256 MiB file cap is 257, and the cap is a
  decode-work bound, not a nonce bound. Restate it as derived from the file-size
  and chunk-size limits.

### Implementability (can a second implementation reproduce the bytes)

- **[blocker → fixed here] Spec/code drift.** `ENCRYPTION.md` named the old
  magic `WBLMENC1`, the old media type, and printed stale known-answer tables,
  and the FSWNENC1 vector generators were not wired into `npm run
  encryption:vector`. Fixed in this change: the doc now names `FSWNENC1` /
  `application/vnd.forgesworn.encrypted` with the correct tables, documents the
  legacy dual-read, and the vector script now validates the FSWNENC1 pair as
  primary and the legacy pair as compatibility.
- **[blocker] "Canonical JSON" is undefined.** The metadata is exactly
  `JSON.stringify({name, size, type})` in that key order with no whitespace, and
  the decoder hard-rejects any deviation, but the spec does not pin key order,
  whitespace, integer format, or a string-escaping profile. A JSON library that
  escapes non-ASCII names as `\uXXXX` produces different bytes and is rejected.
  The `name` must also be a fixed point of the filename sanitiser and `type` of
  the MIME normaliser, neither of which is specified. **Outstanding.**
- **[blocker] Padding-bucket function is prose only.** The exact function
  (`≤64 KiB → 64 KiB`; `≤1 MiB → next power of two`; else next 1 MiB) is a hard
  decode check, but the spec does not state whether its input is the source size
  or the logical `4 + metadata + source` length (it is the logical length), nor
  pin the behaviour at exactly 1 MiB. **Outstanding.**
- **[minor] Endianness and framing of the inner length, the AAD counter, and the
  last-record remainder are only inferable.** State them.

### Normative language and vectors

- **[major] No RFC 2119 language.** The validation rules are one descriptive
  sentence. Rewrite each rejection path as a testable MUST. **Outstanding.**
- **[major] No shareable negative vectors.** All tamper tests are TypeScript
  only, and three rejection paths (non-canonical metadata, over-max record
  count, bad padding bucket) are untested even there. Publish a negative-vector
  file: bad magic, bad chunk size, record count 0 / over-max, flipped tag byte,
  reordered records, truncated final record, appended byte, altered header
  field, non-canonical metadata, wrong padding bucket, non-canonical `wbk1_`
  key. **Mostly done:** `test-vectors/encryption-negative.json` (12 cases)
  now covers the magic, header, authentication (tag, ciphertext, altered
  header, wrong key, record-tag integrity), length and recovery-key classes,
  each asserted against the reference decoder. The two constructed cases
  (non-canonical metadata, wrong padding bucket) remain, since they need an
  envelope built from scratch under the test key rather than a byte mutation.

## `FSWNENC2`: the agreed shared-key fix

A coordinated change with the Stash implementation, agreed by both owners.

- **One header layout for both modes.** The clear header always carries a
  32-byte random salt. There is no mode flag on the wire; the provenance of the
  input key material (a fresh per-file random key, or a vault key) is invisible
  in the envelope.
- **Per-envelope key derivation.**
  `envelope_key = HKDF-SHA256(ikm = input_key, salt = header_salt, info =
  "forgesworn-aes-256-gcm-chunked/v2")`. Because every envelope derives a unique
  AES key from a fresh 32-byte salt, the counter-from-zero nonce is safe and
  cross-envelope collision is a non-issue in both modes.
- **Version and naming.** `FSWNENC2` dual-reads `FSWNENC1`; the magic is the
  version field, so no separate version tag. Scheme name
  `forgesworn-aes-256-gcm-chunked-v2`. The v1 vectors keep their historical
  `wildbloom-aes-256-gcm-chunked-v1` scheme name, frozen.
- **Cadence.** Normal cadence, not a hotfix: Wildbloom's per-file mode is not
  exposed, and no vault is near the ceiling. Ships with per-file and vault
  known-answer vectors; Stash's existing vault-key vector becomes the vault KAT
  under the new construction.

## Remediation status

Done:

- Spec/code drift fixed: `FSWNENC1`, `application/vnd.forgesworn.encrypted`,
  correct known-answer tables, documented dual-read.
- `npm run encryption:vector` pins the `FSWNENC1` pair as primary and the legacy
  pair as compatibility.
- Versioning, the legacy-read rule, and the `FSWNENC2` plan recorded normatively
  in `ENCRYPTION.md`.
- Canonical metadata (key order, no whitespace, base-10 integer size, the
  name / type normalisation as fixed points, and a pinned JSON string-escaping
  profile) and the padding-bucket formula pinned in `ENCRYPTION.md`.
- The validation rules rewritten as an enumerated RFC 2119 MUST list, with
  no-partial-acceptance stated.
- Language-neutral negative-vector file
  (`test-vectors/encryption-negative.json`, 12 cases) published and asserted
  against the reference decoder.

Outstanding, in priority order:

1. `FSWNENC2`: pin the exact header grammar with the salt offset, the HKDF
   parameters, and both a per-file and a vault known-answer vector; then
   implement across both codebases (coordinated with the Stash implementation).
2. Add the two constructed negative cases (non-canonical metadata, wrong padding
   bucket), which require an envelope built from scratch under the test key.
3. Correct the record-count residual-risk figure (state the derived maximum, not
   258, and that it is a decode-work bound).
4. Commission a third-party cryptographic audit before treating the format as a
   settled public standard.
