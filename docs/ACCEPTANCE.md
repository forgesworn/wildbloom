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
- User cancellation closes an in-flight upload and partial-body download,
  clears stale output and leaves a safe retry path.
- Tor-only rejection of clearnet endpoints and absence of torrent metadata or
  WebRTC controls.
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

## Real Tor transport gate

Run this separately with Tor and Playwright Chromium installed:

```sh
npx playwright-core install chromium
npm run build
npm run acceptance:tor -- --browser chromium
```

The gate launches a fresh Tor daemon with cookie-authenticated loopback
control and disposable v3 onion services for the production app, Blossom and
Nostr relay. It publishes only ciphertext, receives the exact relay
acknowledgement, requests `NEWNYM`, recovers the exact source in a fresh browser
context without a signer, refuses WebRTC and proves a denied Blossom target
does not retain a stale download. Temporary onion keys are deleted after Tor
has stopped. The on-demand `tor-acceptance` GitHub workflow runs the same gate
on Linux.

Chromium does not treat HTTP onion origins as secure contexts, so the harness
uses Chromium's test-only secure-origin override to exercise Wildbloom's Web
Crypto path. The branded Tor Browser path is expected to supply that secure
context, but remains part of its manual release gate. The automated gate is
real Tor transport evidence, not branded Tor Browser interaction.

## Release gates not yet satisfied

- Independent cryptographic and browser security review.
- Branded Tor Browser exercise against disposable real v3 onion Nostr and
  Blossom services, including denial, cancellation, timeout and identity-change
  behaviour. The automated Chromium gate proves real onion transport and
  `NEWNYM`, but Playwright cannot drive the branded Tor Browser binary.
- A supported extension-free signer path for high-anonymity Tor publication.
- Two-device WebTorrent seeding and retrieval across the intended production
  network boundary, with host-candidate and any future operator ICE traffic
  checked against packet capture. The automated two-context loopback gate does
  not prove NAT traversal or absence of lower-level browser traffic.
- Branded Firefox and real Safari desktop coverage on their supported
  operating systems; Playwright's patched Firefox and WebKit builds are useful
  engine evidence but not those branded-browser releases.
- Keyboard and screen-reader review.
- Maximum-size and low-memory tests. Controlled browser interruption and
  cancellation are automated; operating-system loss and device pressure are
  not yet proven.
- Production host selection, TLS/HSTS, onion address custody, monitoring,
  rollback and log-retention policy.
- Legal name clearance, licence decision, privacy notice and operator support
  route.

Until those gates are evidenced, describe Wildbloom as a private production
candidate, not a production service and not an anonymity system.
