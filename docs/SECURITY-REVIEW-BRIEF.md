# Independent security review brief

Wildbloom needs an independent cryptographic and browser security review before
it can leave production-candidate status. This brief defines a bounded,
reproducible engagement which a reviewer can quote and execute without gaining
signing credentials or production write access.

The application source baseline is commit
`b894f4693b1c8707f4ae0d359ef1702e9b25cdff`. Documentation-only changes after
that commit do not change the review target. Any source remediation must receive
its own review and retest.

## Independence and disclosure

The lead reviewer must not have designed or implemented Wildbloom, its
encryption envelope or the test harnesses used as evidence. Prior work for a
dependency or protocol does not by itself create a conflict, but it must be
declared. The reviewer must retain the right to report disagreement with the
maintainers' threat model or compatibility claims.

Findings must initially use GitHub private vulnerability reporting or another
agreed encrypted channel. The final report should be public after a bounded
remediation period and must identify the reviewed commit, reviewer, dates,
methods, limitations, unresolved findings and retest status. A public report is
part of the release evidence; a private attestation alone does not close the
gate.

## System and claims under review

Wildbloom is a framework-free TypeScript browser application which publishes
and retrieves the same encrypted file through existing protocols:

- Nostr provides signed discovery using NIP-07 or an exact manual unsigned-event
  handoff;
- Blossom provides content-addressed HTTP upload and retrieval; and
- BitTorrent/WebTorrent provides deliberate peer delivery.

The review must test the claims in [`THREAT-MODEL.md`](THREAT-MODEL.md), not
infer stronger claims. In particular, Wildbloom does not claim anonymity,
availability, retraction or internet-wide peer connectivity. Network endpoints,
peers, signed content and returned bytes are untrusted. Recovery keys protect
content but not public identity, timing, endpoints, ciphertext size or access
patterns.

## Work packages

### 1. Encryption format and key handling

Review the `FSWNENC2` writer, dual-version reader, specifications and
language-neutral vectors in:

- `src/core/crypto.ts`;
- `docs/ENCRYPTION.md` and `docs/FSWNENC2.md`;
- `test-vectors/`; and
- the crypto and vector tests and scripts.

The review should cover HKDF-SHA256 domain separation, random salt and nonce
handling, AES-256-GCM record construction, authenticated framing, truncation,
reordering, duplication and cross-envelope splicing, canonical metadata,
padding validation, parser bounds, integer and allocation edges, canonical
recovery-key encoding, version separation and key erasure limits in a browser.
Confirm independently that the published vectors are reproducible from the
written format and that malformed inputs fail without exposing partial
plaintext.

### 2. Browser authority and custody boundaries

Review `src/main.ts` and the injected boundaries in `src/core/` for:

- absence of raw private-key or `nsec` input;
- exact-template validation after NIP-07 and manual external signing;
- no application network action on load;
- distinct, revocable consent for upload, relay publication, seeding, lookup
  and download;
- invalidation and cancellation when files, endpoints, signers, profiles or
  consent change;
- stale asynchronous completion, navigation and back-forward-cache handling;
- recovery-key and plaintext lifetime, browser persistence and object-URL
  cleanup;
- hostile remote strings, MIME types, redirects and response shapes;
- Trusted Types, CSP and executable-download containment; and
- denial of undeclared browser capabilities and implicit public ICE services.

Exercise current Chromium, Firefox and Safari where a finding may depend on
browser implementation rather than JavaScript alone. Treat existing automated
acceptance as regression evidence, not as proof of the reviewed properties.

### 3. Protocol and network boundaries

Review the NIP-94 kind `1063`, NIP-35 kind `2003` and Blossom BUD-01/02/10/11
handling against the referenced drafts. Check event shape and signature
validation, duplicate or conflicting tags, exact-ID relay lookup lifecycle,
upload-authorisation lifetime and hostname/hash scope, descriptor validation,
hash and byte-count binding, torrent reconstruction, single-file enforcement,
web-seed authority and tracker/ICE disclosure.

The `encryption` tag value `wildbloom-aes-256-gcm-chunked-v1` is a documented
Wildbloom extension. The review must distinguish draft requirements, local
implementation choices and extension behaviour, and identify any unsupported
interoperability claim.

Review Tor-only fail-closed behaviour for valid v3 onion endpoints, clearnet
fallback, WebTorrent loading and state transitions. This is a code and browser
boundary review, not a claim that automation reproduces Tor Browser's complete
fingerprint or human interface.

### 4. Build, dependency and production boundary

Review the production module graph, dependency lifecycle-script policy, audit
exception, secret scan, reproducible build evidence, static-server request
limits and response headers. Verify that development and acceptance machinery
cannot enter the production bundle and that the deployed origin serves the
reviewed build. Production probing must be read-only, rate-bounded and agreed in
advance; use local controlled services for hostile or destructive cases.

## Required adversarial cases

The reviewer may expand the test plan. At minimum, attempt:

- signed-event substitution, extra fields, duplicate tags and validly signed
  metadata transformations;
- BUD authorisation replay across hashes, hosts and expiry boundaries;
- malformed, oversized, redirected, truncated and overlong endpoint responses;
- encrypted-envelope header, record, ciphertext, tag, padding and version
  mutations;
- wrong-key and partial-decryption disclosure;
- magnet, torrent metadata, info-hash, length and web-seed disagreement;
- signer, crypto, upload, relay and peer results completing after authority has
  changed;
- DOM injection and active-content download attempts;
- recovery material surviving storage, navigation, cancellation or session
  teardown; and
- Tor-to-clearnet, disabled-WebTorrent or undeclared-ICE escape paths.

## Reproduction

Use Node.js and npm versions pinned by `.nvmrc` and `package-lock.json`:

```sh
npm ci
npm run ci
npm run smoke:swarm
npm run acceptance:firefox
npm run acceptance:tor
```

On-demand Safari, Tor Browser, maximum-file and physical-device ceremonies are
documented in [`ACCEPTANCE.md`](ACCEPTANCE.md). A reviewer may use smaller
targeted tests during discovery, but the complete relevant gates must pass on
the remediated commit.

The production candidate is at <https://wildbloom.forgesworn.dev/>. Never use
sensitive, personal or irreplaceable material during testing. Wildbloom does
not need a private key: use a disposable NIP-07 identity or the documented
manual handoff, and never send an `nsec`, seed phrase or raw signing key to the
application or maintainers.

## Deliverables and closure

The engagement must produce:

1. a scope and conflict-of-interest statement;
2. a report containing severity, affected commit and code, exploitation
   conditions, impact, reproduction and actionable remediation for every
   finding;
3. reviewer-created tests or minimal reproductions which can be retained
   safely;
4. an explicit assessment of each work package and of claims which could not be
   verified;
5. a retest of the exact remediation commits; and
6. a public final report, including unresolved findings and accepted residual
   risk.

Critical and high-severity findings must be fixed and retested before release.
Every medium or lower finding must be fixed or recorded as an explicit residual
risk with rationale. The gate closes only when the final report and remediation
lineage are public and the repository's complete release checks pass.
