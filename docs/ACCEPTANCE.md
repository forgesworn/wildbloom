# Production acceptance

Production quality is a set of evidence gates. A green unit suite alone is not
the finish line.

## Automated on every push

- Node 24 strict TypeScript on GitHub-hosted Windows, Linux and macOS runners.
- Unit and adversarial tests with global core thresholds of 80% statements,
  70% branches, 85% functions and 90% lines.
- Production bundle generation.
- Real Chromium acceptance against the production static server on Windows,
  Linux and macOS.
- The same production journey in Playwright Firefox on Linux and Playwright
  WebKit on macOS.
- Branded Mozilla Firefox on Linux, through a disposable profile and
  loopback-only WebDriver BiDi: trustworthy production origin, no ambient
  application network or signer, local encrypted preparation, exact recovery
  of an independently generated encrypted fixture, relay timeout, partial-body
  cancellation, denied-service failure and no WebRTC.
- Two isolated Chromium contexts publishing and retrieving the encrypted file
  through a real, ephemeral TLS WebSocket tracker.
- Exact source recovery while the controlled Blossom web seed refuses every
  retrieval, proving the bytes came from the other browser peer.
- Runtime observation that both peers receive an empty ICE-server list, gather
  host candidates only, reach a connected WebRTC state, and leave the tracker
  after source change or browser closure.
- Response CSP, framing, referrer, permissions and MIME-sniffing headers.
- No remote request on page load.
- Randomised local encryption and recovery-key gate.
- Blossom upload of ciphertext rather than source bytes.
- Exact hash, server and 90-second BUD-11 upload authority.
- Controlled Nostr relay publish, acknowledgement, exact-ID lookup and signed
  event validation.
- Blossom ciphertext retrieval, signed size/hash verification and local
  authenticated decryption back to the original file.
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

Run the complete gate with:

```sh
npm ci
npm run ci
npm run smoke:swarm
```

The local swarm gate also requires `openssl` to create a disposable test-only
tracker certificate. CI installs the pinned Chromium build and runs the same
gate on Linux.

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

This is a signer-free preparation and retrieval ceremony. It does not claim a
complete branded-Firefox publication or WebTorrent journey.

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
Firefox binary with a disposable profile and loopback-only WebDriver BiDi,
and uses the controlled Tor daemon as its SOCKS transport. No signer extension
or privileged browser access is enabled. It proves secure-context loading,
exact onion authorities, a bounded relay timeout, cancellation of a partial
Blossom response, exact signer-free recovery, absence of WebRTC and fail-closed
service denial. The on-demand `tor-browser-acceptance` workflow downloads a
pinned Linux Tor Browser archive and verifies its Tor Browser Developers
signature before running the same gate.

Chromium does not treat HTTP onion origins as secure contexts, so the base
harness uses Chromium's test-only secure-origin override to exercise
Wildbloom's Web Crypto path. Branded Tor Browser supplies the onion secure
context without that override. Headless remote-control evidence is still not a
human usability, fingerprint-equivalence or extension-free publication claim.

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
  retrieval ceremony, not human usability or fingerprint equivalence.
- A supported extension-free signer path for high-anonymity Tor publication.
- Two-device WebTorrent seeding and retrieval across the intended production
  network boundary, with host-candidate and any future operator ICE traffic
  checked against packet capture. The automated two-context loopback gate does
  not prove NAT traversal or absence of lower-level browser traffic.
- A complete publication and WebTorrent journey in branded Firefox, plus real
  Safari desktop coverage on its supported operating system. The automated
  branded-Firefox preparation/retrieval gate and Playwright engine builds are
  useful evidence but do not prove those remaining paths.
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
