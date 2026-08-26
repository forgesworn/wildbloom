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
not claim to create a new storage network.

## Current status

This is a hardened production candidate, not a deployed service. It currently
supports source files up to 256 MiB. Independent cryptographic review, live
onion-service acceptance, cross-browser testing and a controlled live swarm
remain release gates. See [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).

The canonical build is web-first and targets current browsers on Windows,
Linux and macOS. It is not currently a native desktop application; native
packaging remains conditional on a proven requirement that the browser sandbox
cannot meet. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

No private key enters Wildbloom. Every signature is requested from an injected
NIP-07 signer, and no network action runs on page load. Uploading, relay
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

Tor-only mode does not prove that the browser is actually using Tor. The Tor
Project also discourages both torrenting over Tor and installing extra Tor
Browser add-ons. A NIP-07 add-on or reused Nostr identity therefore remains an
identity and fingerprinting boundary. Read [`docs/PRIVACY.md`](docs/PRIVACY.md)
before treating Tor as useful for a particular threat model.

## Run it locally

Requirements: Node.js 24 or newer and a browser with a NIP-07 extension.

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. Supply your own Blossom server, Nostr
relays and WebSocket trackers. Wildbloom deliberately carries no endorsed
network defaults.

## Verify it

```sh
npm run check
npm run ci
```

`check` runs strict TypeScript, coverage-gated unit and adversarial tests, a
production build, a real headless-browser acceptance path and the local secret
scanner. The browser path proves response security headers and zero ambient
network activity, then exercises encrypted upload, exact Blossom authority,
NIP-07 signing, controlled relay publication and retrieval, ciphertext
download, local recovery, consent reset and Tor-only refusal of clearnet
fallback. `ci` additionally audits dependencies. The audit script has one
fail-closed exception for an `ip` advisory reachable only from WebTorrent's
Node UDP-tracker server parser: Wildbloom imports the prebuilt browser bundle,
and the exception fails if the package's browser exclusions change. Every
other advisory still fails CI.

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
loopback with the repository's response security headers and `/healthz`.
Production TLS, HSTS, host allowlisting, reverse-proxy logging and onion-service
configuration are deployment responsibilities. See
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

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

Private and unlicensed while the production candidate is being evaluated. No permission
is granted to copy, distribute or create derivative works.
