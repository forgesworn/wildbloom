# Threat model

## Protected properties

- **Signing-key custody:** keys remain inside the user's NIP-07 signer.
- **Upload authority scope:** a captured upload token is useful only for one
  hash, one server and at most 90 seconds.
- **Content integrity:** Nostr signatures bind the advertised metadata;
  SHA-256 binds retrieved bytes; BitTorrent piece hashes protect transport.
- **Source confidentiality:** default AES-GCM envelopes protect content,
  filename and MIME type from storage and discovery infrastructure when the
  recovery key remains separate.
- **No ambient publication:** visiting or opening the app performs no network
  operation beyond loading its own local assets.
- **Response containment:** remote text is length-limited, treated as data and
  never inserted as HTML.

## Not protected

- **Recovery-key compromise:** anyone holding the recovery key and ciphertext
  can recover the source. There is no revocation or server-side recovery.
- **Anonymity:** servers, relays, trackers and peers can observe IP addresses,
  timing and requested identifiers. Nostr events are pseudonymous, not
  anonymous.
- **Availability:** neither a Blossom URL nor a torrent guarantees that any
  server or peer will retain the bytes.
- **Retraction:** signed events and files may be copied outside every deletion
  mechanism available to the original publisher.
- **Endpoint honesty:** a signer can display misleading approval UI, a server
  can log or reject uploads, a relay can censor or present a split view, and a
  tracker can enumerate participants.
- **Traffic analysis:** padding hides exact size within a bucket, not timing,
  traffic volume, event identity or repeated ciphertext access.
- **Browser compromise:** extensions, injected scripts or a compromised browser
  can read source bytes and recovery keys before cryptography helps.

## Current attack handling

| Attack | Behaviour |
| --- | --- |
| NIP-07 signer mutates reviewed fields | Reject unless the returned valid signature covers the exact template |
| Upload token replayed elsewhere | `server` and `x` tags constrain it; expiry limits time |
| Blossom descriptor points at different bytes | Reject URL/hash/size mismatch |
| Blossom response is truncated or enlarged | Reject signed byte-count mismatch |
| Blossom response changes content | Reject SHA-256 mismatch |
| Blossom silently redirects | Reject; transport authority never follows redirects |
| Relay returns malformed/oversized data | Ignore or reject; cap each message at 1 MiB |
| Relay returns an event for another ID | Ignore |
| Validly signed event has conflicting duplicate tags | Reject |
| Magnet and Nostr info hash disagree | Reject before joining swarm |
| Magnet adds an extra tracker, web seed or metadata source | Rebuild from validated fields and strip unrecognised parameters |
| Torrent metadata describes multiple files | Reject in this production candidate |
| Remote endpoint uses plaintext | Reject except explicit localhost development |
| Tor-only endpoint is clearnet, v2 onion or checksum-invalid v3 onion | Reject before network access |
| Tor-only flow requests WebTorrent | Reject before the WebTorrent bundle loads |
| Encrypted header, record order, ciphertext or key is wrong | Reject before offering plaintext |
| User changes file or transport profile after consent | Clear all publication and swarm consents |

## Before any public deployment

- Complete the release gates in `docs/ACCEPTANCE.md`, including independent
  cryptographic and browser security review.
- Re-evaluate the documented WebTorrent Node-only `ip` advisory exception on
  every WebTorrent upgrade; CI fails if its browser reachability guard changes.
- Exercise onion publication and retrieval against disposable keys, relays and
  a local Blossom server, and exercise direct mode with a controlled live
  WebTorrent tracker and two browser peers.
- Decide on relay, tracker and server policy without silently turning optional
  defaults into endorsements.
- Preserve the tested response headers at the hosting edge and add HSTS after
  the clearnet domain is proven.
