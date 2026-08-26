# Production acceptance

Production quality is a set of evidence gates. A green unit suite alone is not
the finish line.

## Automated on every push

- Node 24 strict TypeScript on GitHub-hosted Windows, Linux and macOS runners.
- Unit and adversarial tests with global core thresholds of 85% statements,
  75% branches, 88% functions and 94% lines.
- Production bundle generation.
- Real Chromium acceptance against the production static server on Windows,
  Linux and macOS.
- The same production journey in Playwright Firefox on Linux and Playwright
  WebKit on macOS.
- Branded Mozilla Firefox on Linux, through two disposable profiles and
  loopback-only WebDriver BiDi: trustworthy production origin, no ambient
  application network or signer, external-signature encrypted upload and
  two-event relay publication, exact Blossom and real WebRTC-peer recovery,
  host-only ICE, peer cleanup after failed decryption, consent withdrawal and
  page lifecycle teardown, an independently generated encrypted fixture, relay
  timeout, partial-body cancellation and denied-service failure.
- Two isolated Chromium contexts publishing and retrieving the encrypted file
  through a real, ephemeral TLS WebSocket tracker.
- Exact source recovery while the controlled Blossom web seed refuses every
  retrieval, proving the bytes came from the other browser peer.
- Runtime observation that both peers receive an empty ICE-server list, gather
  host candidates only, reach a connected WebRTC state, and leave the tracker
  after failed local decryption, swarm-consent withdrawal and source change,
  before browser closure. A failed recovery exposes no save link and a correct
  retry must complete through a new peer session.
- Response CSP, framing, referrer, permissions and MIME-sniffing headers,
  including denial of Clipboard API access.
- Exact release-file hashes and lengths, no-store HTML, health and errors,
  immutable content-hashed assets, and hostile host, method, absolute-target,
  traversal, source-map and repository-file rejection.
- An explicit deployment verifier that consumes clean release evidence, follows
  no redirect, streams the exact deployed bytes and fails on health, HSTS,
  MIME, cache, security-header, size or SHA-256 drift.
- No remote request on page load.
- No application mutation or retained entries in cookies, local or session
  storage, IndexedDB, Cache Storage or service workers after a complete browser
  journey. Secret and structured controls carry browser-retention hints.
- Peer journeys preserve but do not consume a hostile pre-existing
  `localStorage.debug` preference, emit no dependency debug diagnostics, then
  leave no browser state after the harness removes its fixture.
- Page lifecycle teardown clears recovery material, file and endpoint
  selections, signing handoff JSON, signer identity, object URLs and every
  consent. Navigation away and back cannot restore network authority; an active
  peer downloader must also leave the controlled tracker before page closure.
- Randomised local encryption and a canonical recovery-key gate that rejects
  alternate base64url spellings of the same key bytes.
- The published independent one- and two-record AES-GCM known-answer envelopes
  are resolved through the controlled relay and Blossom server, rejected with
  a wrong key without a stale save link, then recovered byte-for-byte through
  production Web Crypto in system Chromium on Windows, Linux and macOS,
  Playwright Firefox on Linux and Playwright WebKit on macOS.
- Blossom upload of ciphertext rather than source bytes.
- Exact hash, server and 90-second BUD-11 upload authority.
- Exact external signed-event handoff: a validly signed changed template is
  rejected before network access, the injected NIP-07 signer is never called,
  and deliberate upload authority is capped at five minutes.
- Controlled Nostr relay publish, acknowledgement, exact-ID lookup and signed
  event validation.
- Blossom ciphertext retrieval, signed size/hash verification and local
  authenticated decryption back to the original file.
- Validly signed transformed `ox` hashes and false Wildbloom encrypted-envelope
  metadata are rejected; verified save links expose only inert octet-stream
  object URLs rather than executable remote MIME types in Wildbloom's origin.
- Consent invalidation when the file or network profile changes.
- Superseded local encryption cannot restore stale file facts or recovery
  material after the selected file changes.
- A delayed direct-mode signer result is discarded across a Tor-profile
  switch; signer identity is cleared and must be connected again.
- Withdrawing Tor confirmation clears signer identity and pending network
  authority.
- User cancellation closes an in-flight upload and partial-body download,
  clears stale output and leaves a safe retry path.
- Axe-core WCAG A/AA scans of the initial, encrypted preparation, verified
  recovery, Tor-only and plaintext opt-out states.
- Keyboard traversal, visible focus, recovery-key reveal and active transfer
  cancellation.
- WCAG scanning and absence of horizontal overflow at a 320 CSS-pixel viewport,
  plus visible focus and scanning under Chromium forced-colours emulation.
- Tor-only rejection of clearnet endpoints and absence of torrent metadata or
  WebRTC controls.
- Adversarial envelope header, length and record-order authentication; exact
  scalar event tags; bounded upload authority; relay split views, cancellation
  and fan-out limits.
- Secret scan and guarded dependency audit.
- Dependency lifecycle scripts disabled for local and hosted clean installs,
  with strict engine and peer resolution and exact build-tool versions in
  release evidence.

Run the complete gate with:

```sh
npm ci
npm run ci
npm run smoke:swarm
```

The local Chromium and branded-Firefox peer gates require `openssl` to create a
disposable test-only tracker certificate. The harness accepts only that
ephemeral self-signed tracker certificate; this does not weaken the production
application's transport validation. CI installs the pinned Chromium build and
runs the Chromium gate on Linux.

Run the additional engines locally after installing their exact Playwright
builds:

```sh
npx playwright-core install firefox webkit
npm run build
npm run smoke:browser:firefox
npm run smoke:browser:webkit
```

Playwright may freeze WebKit support on an older host operating system. A
stalled or frozen local runtime is not stronger evidence than the current
macOS CI job.

Run the genuine installed Mozilla Firefox gate separately with:

```sh
npm run build
npm run acceptance:firefox
```

This drives two independent Firefox processes. One completes extension-free
encrypted publication and seeding; the other performs signer-free exact peer
recovery while the published Blossom object is unavailable. The gate requires
the declared WSS tracker, host-only ICE and confirmed peer cleanup after
failed local decryption, consent withdrawal and source change. It also recovers
the published encryption known-answer vector generated by Node's independent
AES-GCM implementation, so browser recovery is checked against a stable
interoperability contract rather than only application-produced ciphertext.

## Real Tor transport gate

Run this separately with Tor and system Chrome or Chromium installed:

```sh
npm run build
npm run acceptance:tor -- --browser system-chromium
```

Where a branded Tor Browser binary is installed, run the extended gate:

```sh
npm run acceptance:tor-browser
```

The gate launches a fresh Tor daemon with cookie-authenticated loopback
control and disposable v3 onion services for the production app, Blossom and
Nostr relay. It publishes only ciphertext, receives the exact relay
acknowledgement, requests `NEWNYM`, recovers the exact source in a fresh browser
context without a signer, refuses WebRTC and proves a denied Blossom target
does not retain a stale download. Temporary onion keys are deleted after Tor
has stopped. The on-demand `tor-acceptance` GitHub workflow runs the same gate
on Linux.

Tor bootstrap and hostname-file creation are not treated as application
readiness. Initial onion navigation is retried within the same bounded
three-minute window before the publication ceremony begins. Readiness requires
an HTTP-successful exact-origin document load and a visible application marker;
it does not depend on Playwright's unreliable `networkidle` heuristic over Tor.
After `NEWNYM`, the fresh browser context must independently re-establish both
controlled service onions before the one-shot signed-event lookup begins; the
product's bounded relay timeout is not weakened or silently retried.

The extended gate requests another `NEWNYM`, launches the actual Tor Project
Firefox binary with a disposable profile and loopback-only WebDriver BiDi.
With no signer extension or privileged browser access, that profile prepares
ciphertext, imports exact externally produced signatures, uploads and publishes
through the controlled onions. The browser is closed, Tor acknowledges
`NEWNYM`, and a second fresh profile proves secure-context loading, exact onion
authorities, a bounded relay timeout, cancellation of a partial Blossom
response, exact signer-free recovery, absence of WebRTC and fail-closed service
denial. The on-demand `tor-browser-acceptance` workflow downloads a
pinned Linux Tor Browser archive and verifies its Tor Browser Developers
signature before running the same gate.

Chromium does not treat HTTP onion origins as secure contexts, so the base
harness uses Chromium's test-only secure-origin override to exercise
Wildbloom's Web Crypto path. Branded Tor Browser supplies the onion secure
context without that override. Headless remote-control evidence is still not a
human usability or fingerprint-equivalence claim.

## Maximum source round-trip gate

Run the exact source boundary separately in system Chrome or Chromium:

```sh
npm run build
npm run acceptance:maximum
```

The gate creates a real 256 MiB browser `File`, hashes and encrypts it through
the production UI under a constrained V8 heap, uploads the exact
269,488,168-byte envelope, signs and publishes its events, resolves the NIP-94
event by exact ID, downloads and verifies the ciphertext, decrypts locally and
stream-hashes the downloaded 256 MiB result. It also proves 256 MiB plus one
byte is rejected before recovery material or upload authority survives. The
on-demand `maximum-file-acceptance` workflow runs the same test on Linux.
Binary Blob storage is not all charged to the V8 heap, so this is exact-limit
and heap-bounded evidence, not an operating-system low-memory simulation.

## Release gates not yet satisfied

- Independent cryptographic and browser security review.
- Human Tor Browser publication and retrieval review, including browser chrome,
  security-level changes, new-identity behaviour, cancellation and timeout UI.
  The automated headless branded-browser gate covers the content-engine
  publication and retrieval ceremony, not human usability or fingerprint
  equivalence. External-signer interoperability also needs human review with
  the intended signing application and transfer medium.
- Two-device WebTorrent seeding and retrieval across the intended production
  network boundary, with host-candidate and any future operator ICE traffic
  checked against packet capture. The automated two-context loopback gate does
  not prove NAT traversal or absence of lower-level browser traffic.
- Real Safari desktop coverage on its supported operating system. Playwright
  WebKit is useful engine evidence but is not the installed Safari product.
- Manual screen-reader, real browser zoom, forced-colours appearance and human
  keyboard-usability review. Automated WCAG scanning, 320px reflow,
  forced-colours semantics and keyboard mechanics are covered.
- Operating-system memory-pressure and low-end-device tests. The exact maximum
  size and a constrained JS heap are automated, but Blob storage may live
  outside that heap. Operating-system loss is also not yet proven.
- Production host selection, TLS/HSTS, onion address custody, monitoring,
  rollback and log-retention policy.
- Legal name clearance, licence decision, privacy notice and operator support
  route.

Until those gates are evidenced, describe Wildbloom as a private production
candidate, not a production service and not an anonymity system.
