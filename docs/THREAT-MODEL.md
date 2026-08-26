# Threat model

## Protected properties

- **Signing-key custody:** keys remain inside the user's NIP-07 signer.
- **Upload authority scope:** a captured upload token is useful only for one
  hash, one server and at most 90 seconds.
- **Content integrity:** Nostr signatures bind the advertised metadata;
  SHA-256 binds retrieved bytes; BitTorrent piece hashes protect transport.
- **No ambient publication:** visiting or opening the app performs no network
  operation beyond loading its own local assets.
- **Response containment:** remote text is length-limited, treated as data and
  never inserted as HTML.

## Not protected

- **Confidentiality:** files are plaintext unless the user encrypts them before
  selection. Hashes can confirm guesses about known content.
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

## Current attack handling

| Attack | Behaviour |
| --- | --- |
| NIP-07 signer mutates reviewed fields | Reject unless the returned valid signature covers the exact template |
| Upload token replayed elsewhere | `server` and `x` tags constrain it; expiry limits time |
| Blossom descriptor points at different bytes | Reject URL/hash/size mismatch |
| Blossom response is truncated or enlarged | Reject signed byte-count mismatch |
| Blossom response changes content | Reject SHA-256 mismatch |
| Relay returns malformed/oversized data | Ignore or reject; cap each message at 1 MiB |
| Relay returns an event for another ID | Ignore |
| Validly signed event has conflicting duplicate tags | Reject |
| Magnet and Nostr info hash disagree | Reject before joining swarm |
| Torrent metadata describes multiple files | Reject in this prototype |
| Remote endpoint uses plaintext | Reject except explicit localhost development |

## Before any public deployment

- Add an independent browser security review and dependency audit.
- Re-evaluate the documented WebTorrent Node-only `ip` advisory exception on
  every WebTorrent upgrade; CI fails if its browser reachability guard changes.
- Exercise publication and retrieval against disposable keys, relays, a local
  Blossom server and a controlled WebTorrent tracker.
- Add client-side encryption if confidentiality is a product requirement, then
  document filename, size, hash and access-pattern leakage.
- Decide on relay, tracker and server policy without silently turning optional
  defaults into endorsements.
- Add CSP response headers at the hosting edge; the HTML meta policy is only a
  defence-in-depth development baseline.
