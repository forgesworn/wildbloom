# Wildbloom

**Files that outlive their host.**

Wildbloom is a local-first browser prototype that makes one file available
through three existing protocols:

- Nostr provides signed discovery and attribution.
- Blossom provides content-addressed HTTP upload and retrieval.
- BitTorrent/WebTorrent provides peer delivery, with the Blossom URL embedded
  as a web seed.

The primary object is a standard NIP-94 kind `1063` event containing a Blossom
URL, SHA-256, magnet URI and torrent info hash. Wildbloom also creates a NIP-35
kind `2003` torrent index event. It does not put file bytes on Nostr and does
not claim to create a new storage network.

## Prototype status

This is working prototype code, not a deployed service and not a privacy
system. It currently supports one-file torrents up to 256 MiB. Browser peers
need at least one user-supplied WebSocket tracker.

No private key enters Wildbloom. Every signature is requested from an injected
NIP-07 signer, and no network action runs on page load. Uploading, relay
publication, seeding, relay lookup and downloading are separate user actions.

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

`check` runs strict TypeScript, unit tests, a production build, a real
headless-browser smoke and the local secret scanner. The browser smoke blocks
unrecognised remote traffic, proves page load has no ambient network activity,
and exercises hashing, scoped Blossom authorisation, upload handling, torrent
metadata and NIP-07 signing against controlled fakes. `ci` additionally audits
dependencies. The audit script has one
fail-closed exception for an `ip` advisory reachable only from WebTorrent's
Node UDP-tracker server parser: Wildbloom imports the prebuilt browser bundle,
and the exception fails if the package's browser exclusions change. Every
other advisory still fails CI.

## What publication reveals

- A Blossom upload reveals the file and network metadata to that server.
- A public Nostr event permanently associates the file metadata with the
  signing public key, subject to relay retention.
- A torrent tracker and peers can observe IP addresses and torrent activity.
- SHA-256 and BitTorrent piece hashes provide integrity, not confidentiality.

Do not use sensitive material without adding client-side encryption and
reviewing what the resulting ciphertext metadata still reveals. See
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

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

Private and unlicensed while the prototype is being evaluated. No permission
is granted to copy, distribute or create derivative works.
