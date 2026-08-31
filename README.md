# Wildbloom

**Files that outlive their host.**

Wildbloom is a local-first browser application that makes one file available
through three existing protocols:

- Nostr provides signed discovery and attribution.
- Blossom provides content-addressed HTTP upload and retrieval.
- BitTorrent/WebTorrent provides peer delivery, with the Blossom URL embedded
  as a web seed.

The primary object is a standard NIP-94 kind `1063` event containing a Blossom
URL, SHA-256, magnet URI and torrent info hash. Wildbloom also creates a NIP-35
kind `2003` torrent index event. It does not put file bytes on Nostr and does
not turn the browser itself into a storage node. The companion
[Wildbloom Node](https://github.com/forgesworn/wildbloom-node) project adds
operator-owned, persistent Blossom storage and authorised replication without
changing this browser protocol.

## Current status

The hardened production-candidate build is deployed at
[wildbloom.forgesworn.dev](https://wildbloom.forgesworn.dev/).  It is not yet
declared a production service.  It currently supports source files up to 256
MiB. [Independent cryptographic and browser security
review](docs/SECURITY-REVIEW-BRIEF.md), live human Tor Browser usability review,
and a completed physical-device packet-evidence run remain release gates.
Functional installed-Safari coverage now runs as a separate on-demand native WebDriver gate. See
[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).

The canonical build is web-first and targets current browsers on Windows,
Linux and macOS. It is not currently a native desktop application; native
packaging remains conditional on a proven requirement that the browser sandbox
cannot meet. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

No private key enters Wildbloom. Signatures come from an injected NIP-07 signer
or an exact copy/sign/paste handoff to an external signer. Wildbloom accepts
only the returned signed event and never contacts that signer. No network action runs on page load. Uploading, relay
publication, seeding, relay lookup and downloading are separate user actions.

Local encryption is enabled by default. Wildbloom creates a random 256-bit
recovery key, encrypts the content, filename and MIME type in authenticated
chunks, pads the payload, and uploads only the encrypted envelope. The recovery
key never enters Blossom, Nostr, a torrent or browser storage. Losing it loses
the file.

## Network profiles

- **Direct encrypted delivery:** Nostr, Blossom and WebTorrent. Servers,
  trackers and peers can observe network metadata and IP addresses. Wildbloom
  supplies no implicit public STUN/TURN server, so current peer connectivity is
  deliberately best-effort and may be limited to compatible local networks.
- **Tor-only encrypted delivery:** exact checksum-valid v3 onion services for
  Nostr and Blossom. Clearnet endpoints, trackers and WebRTC are refused.

A Wildbloom Node can be used as an ordinary HTTPS Blossom endpoint or, when
chosen, as the Tor-only onion endpoint.  Tor mode needs no inbound router rule;
direct mode uses operator-managed HTTPS and exposes ordinary network metadata.
Neither node path uses WebRTC, STUN nor TURN.  A second node can mirror the
exact encrypted blob through standard BUD-04. See
[`docs/NODE.md`](docs/NODE.md) for what that does and does not prove.

Use Tor Browser for Tor-only mode, not an ordinary browser pointed at a SOCKS
proxy. Wildbloom cannot prove that the browser is actually using Tor, and a
normal browser lacks Tor Browser's fingerprint protections and may not provide
Web Crypto on HTTP onion origins. The Tor Project also discourages both
torrenting over Tor and installing extra Tor Browser add-ons. A NIP-07 add-on
or reused Nostr identity therefore remains an identity and fingerprinting
boundary. External handoff avoids the add-on but still exposes the public event
and identity to the chosen signer and transfer medium. Read
[`docs/PRIVACY.md`](docs/PRIVACY.md) and
[`docs/EXTERNAL-SIGNING.md`](docs/EXTERNAL-SIGNING.md) before treating Tor as
useful for a particular threat model.

## Run it locally

Requirements: Node.js 24.x and a current browser. The canonical hosted build
uses the exact Node patch in `.nvmrc`; update that pin only with a complete
platform-matrix run. Publishing needs either a
NIP-07 extension or a separate signer that can return canonical signed Nostr
event JSON. Later Node
majors require a deliberate platform-matrix upgrade rather than an assumed
compatibility claim.

```sh
npm ci
npm run dev
```

Repository npm policy disables dependency lifecycle scripts, enforces the Node
24 and npm 11 engines and strict peer resolution. GitHub Actions also
passes `--ignore-scripts` explicitly. The production browser build does not
need the native Node install hooks carried by WebTorrent's cross-runtime
dependency tree. Hosted Playwright commands also resolve the already locked
package offline rather than allowing `npx` to fetch a missing package.

Open the local URL printed by Vite. Supply your own Blossom server, Nostr
relays and WebSocket trackers. Wildbloom deliberately carries no endorsed
network defaults.

## Verify it

```sh
npm run check
npm run ci
npm run encryption:vector
npm run acceptance:deployment
npm run verify:deployment -- --origin https://wildbloom.example --evidence ../wildbloom-release-evidence.json
npm run acceptance:firefox
npm run smoke:swarm
npm run acceptance:cross-device:self-test
npm run acceptance:tor
npm run acceptance:tor-browser
npm run acceptance:maximum
```

`check` verifies the published one- and two-record encryption known-answer
vectors, runs strict TypeScript, coverage-gated unit and adversarial tests, a
production build,
adversarial deployment acceptance, a real headless-browser acceptance path and
the local secret scanner. The deployment gate verifies the
exact served build hashes, strict immutable asset names, no-store HTML, health
and error responses, exact fail-closed response security headers and hostile
configuration, host, method, path, query-string and request-body rejection. It
also covers malformed HTTP framing and headers at the raw socket boundary, and
proves that private rejection markers do not reach the origin server's output.
The running server is also required to retain its exact bounded startup
snapshot if the underlying release directory is changed. CI runs the browser
path in system Chromium on
Windows, Linux and macOS, Playwright Firefox on Linux and Playwright WebKit on
macOS. It proves response security headers, zero ambient network activity,
denial of supported unused browser capabilities, protected browser input hints,
and no cookies, persistent browser-store mutations or retained browser state
after the journey. Chromium additionally proves that DOM injection sinks
require Trusted Types while application-created policies are forbidden. Each
hosted browser engine also rejects a
wrong key for the published independent AES-GCM vectors without exposing a
save link, then recovers both exact sources across the authenticated chunk
boundary. The journey exercises encrypted upload, exact Blossom authority,
NIP-07 and exact external signing, controlled relay publication and retrieval,
ciphertext download, local recovery, consent reset and Tor-only refusal of
clearnet fallback. It rejects validly signed transformed hashes and false
encrypted-envelope metadata, while verified saves use inert octet-stream object
URLs rather than executable remote MIME types. It also supersedes an active
local encryption, holds a signer request
across a direct-to-Tor profile change, and proves that neither older operation
can restore stale recovery, identity or publication state. Withdrawing Tor
confirmation clears signer identity and downstream network authority. A
separate Chromium gate drives two isolated production pages through
a real TLS WebSocket tracker, refuses every Blossom web-seed request, recovers
the exact source from the browser peer, observes host-only ICE, isolates a
pre-existing browser debug preference from WebTorrent, and proves that
failed local decryption stops the downloading peer before a clean retry,
withdrawing swarm consent stops it before tab closure, and changing the source
stops the publishing peer. Browser acceptance also
interrupts a real hung upload and partial download, checks that cancellation closes the
connection, removes stale output and permits a safe retry. It scans five
dynamic states with axe-core WCAG A/AA rules and proves visible keyboard focus
and keyboard-triggered reveal and cancellation actions. Page lifecycle
acceptance clears secrets, signer state, object URLs and network authority on
navigation, proves an active downloader leaves the tracker, and prevents a
back-forward-cache return from reviving the old heap. See
[`docs/ACCESSIBILITY.md`](docs/ACCESSIBILITY.md) for the remaining human review.
`ci` additionally audits dependencies. The audit script has one fail-closed
exception for an `ip` advisory reachable only from WebTorrent's Node UDP-tracker
parser: Wildbloom imports the prebuilt browser bundle, and the exception fails
if the package exclusions, Wildbloom's exact import or the browser-bundle
contents change. Vite also rejects that Node code from the actual production
module graph. Every other advisory still fails CI.

Each Windows, Linux and macOS verification job also emits bounded release
evidence for its own build. A separate job validates those records against the
checked-out source commit and requires identical package locks, Node/npm
toolchains, file lists, lengths and SHA-256 values before CI can pass. The
comparison uses metadata only; the production bundle is not retained as a
workflow artefact.

CI also drives the GitHub runner's genuine branded Mozilla Firefox release
through two disposable profiles and loopback-only WebDriver BiDi. That separate
gate proves a trustworthy production origin, no ambient application network or
signer, external-signature encrypted upload and relay publication, exact
recovery through both Blossom and a second real Firefox WebRTC peer, host-only
ICE, peer cleanup after failed decryption and consent withdrawal, a published
independently generated known-answer fixture, timeout, cancellation
and denied-service failure. The active peer is also required to leave the
tracker when the page session ends.

The on-demand `safari-acceptance` workflow drives the Safari product installed
on a macOS 26 runner through Apple's native SafariDriver, not Playwright
WebKit. Its isolated automation window completes the exact external-signature
encrypted upload and two-event relay publication, recovers both its own upload
and an independently generated encryption vector after wrong-key rejection,
and proves bounded relay timeout, partial-response cancellation, denied-service
failure and page lifecycle clearing. SafariDriver permits one Safari automation
session at a time, so the separate two-browser swarm gate remains the
peer-delivery proof.

The separate [cross-device acceptance ceremony](docs/CROSS-DEVICE-ACCEPTANCE.md)
serves the exact production build and controlled Blossom, relay and WebSocket
tracker through an operator-trusted LAN TLS origin. Two physical devices must
recover the public fixture through direct WebRTC while Blossom refuses the
object. A fail-closed `tcpdump` verifier correlates the service record with the
packet capture and emits a redacted, schema-versioned result. The tooling does
not automate signing or weaken HTTPS/WSS, and its presence is not evidence that
the physical-device run has passed.

`acceptance:tor` requires a local Tor executable and system Chrome or Chromium.
It creates fresh disposable v3 onion services for the app, Blossom and a Nostr
relay, then performs encrypted publication and exact recovery through a real
Tor daemon after `NEWNYM`. Stock Chromium needs a harness-only secure-origin
override for Web Crypto on HTTP onion origins. The extended
`acceptance:tor-browser` gate rotates identity again and drives a signed Tor
Project Firefox build through a disposable profile and loopback WebDriver BiDi.
With no signer extension, one profile encrypts, externally signs, uploads and
publishes through the controlled onions. After `NEWNYM`, a second fresh profile
proves signer-free exact retrieval, relay timeout, partial-download
cancellation, no WebRTC and denied-service failure. The separate GitHub
workflows run both gates on demand. Headless automation is not a manual
usability or fingerprint-equivalence claim.

`acceptance:maximum` drives the exact 256 MiB source limit through encryption,
Blossom upload, signed relay publication, exact-ID resolution, ciphertext
download, verification and local decryption in system Chrome with a constrained
V8 heap. It hashes the recovered download and proves that 256 MiB plus one byte
fails before recovery or upload authority remains. The separate
`maximum-file-acceptance` workflow runs it on demand. This is not proof of
operating-system memory pressure or a low-end device.

## What publication reveals

- An encrypted Blossom upload still reveals ciphertext size, hash, timing and
  network metadata to that server.
- A public Nostr event permanently associates the file metadata with the
  signing public key, subject to relay retention.
- A torrent tracker and peers can observe IP addresses and torrent activity.
- WebRTC connection candidates expose network addresses to the remote peer.
  Wildbloom disables WebTorrent's inherited public Google/Twilio STUN defaults;
  an internet-capable ICE service needs separate operator review and disclosure.
- SHA-256 and BitTorrent piece hashes provide integrity, not confidentiality.
- A recovery key protects content, not the public event's author, timestamp,
  endpoints or access pattern.

Encryption is the default, but the envelope format has not yet received an
independent cryptographic review. See [`docs/ENCRYPTION.md`](docs/ENCRYPTION.md)
and [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Production serving

`npm run build && npm run serve:production` serves the built application on
loopback with the repository's response security headers and `/healthz`. The
server fails closed on unknown configuration, refuses all query strings and
request bodies, bounds HTTP parsing, and does not log request targets, headers
or bodies. It serves a validated, size-bounded startup snapshot so filesystem
changes cannot silently mutate a running release.
Production TLS, HSTS, host allowlisting, reverse-proxy logging and onion-service
configuration are deployment responsibilities. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

The production deployment, monitoring, rollback and evidence-retention process
is in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).  Non-sensitive questions use
[`SUPPORT.md`](SUPPORT.md); security-sensitive reports use GitHub's private
vulnerability reporting and never a public issue.

`npm run release:evidence -- --require-clean` emits the full source commit,
package-lock hash, aggregate build hash and the SHA-256 and length of every
served file. Record that JSON beside the deployment and rollback evidence.

After deployment, `verify:deployment` performs an explicit read-only probe of
the chosen origin. It refuses redirects, verifies `/healthz`, HSTS on HTTPS,
the exact release bytes and hashes, MIME and cache policy, and the complete
security-header boundary before emitting a timestamped verification record.

## Specifications

- [NIP-07: browser signer](https://github.com/nostr-protocol/nips/blob/master/07.md)
- [NIP-35: torrents](https://github.com/nostr-protocol/nips/blob/master/35.md)
- [NIP-94: file metadata](https://github.com/nostr-protocol/nips/blob/master/94.md)
- [Blossom BUDs](https://github.com/hzrd149/blossom/tree/master/buds)

These specifications are draft/optional where they say so. Compatibility is
therefore tested against the documented shapes, not promised forever.

## Name

Wildbloom is a working name and has not received legal trade mark clearance.

## Licence

Wildbloom is free and open-source software under the [MIT Licence](LICENSE).

If this work is useful, you can support its continued development through the
[ForgeSworn sponsorship links](https://github.com/sponsors/TheCryptoDonkey).
