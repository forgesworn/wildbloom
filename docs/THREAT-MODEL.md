# Threat model

## Protected properties

- **Signing-key custody:** keys remain inside the user's NIP-07 or external
  signer. External mode transfers only an unsigned template out and a signed
  event back.
- **Upload authority scope:** a captured upload token is useful only for one
  hash and one server. NIP-07 authority lasts 90 seconds; deliberate external
  handoff is capped at five minutes.
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
| External signer returns malformed, oversized, extra-field, wrong-author or changed event JSON | Parse within 128 KiB and reject unless the strict signed-event shape, author, signature and every template field are exact |
| Validly signed event claims Wildbloom encryption around non-canonical public metadata | Reject unless `x` and `ox` identify the same unchanged envelope and its public filename, MIME type and accessibility label are canonical |
| Upload token replayed elsewhere | Exact scalar `server` and `x` tags constrain it; duplicate scopes are rejected, the human-readable purpose is canonical, and Wildbloom issues a 90-second NIP-07 or five-minute external lifetime (the encoder rejects stale authority or anything beyond that hard cap) |
| Encrypted event identifies known source bytes | Both NIP-94 `x` and pre-upload-server-transformation `ox` hash only the randomised encrypted envelope, never the plaintext source |
| Blossom descriptor points at different bytes | Reject URL/hash/size mismatch |
| Blossom response is truncated or enlarged | Reject signed byte-count mismatch |
| Blossom response changes content | Reject SHA-256 mismatch |
| Blossom silently redirects | Reject; transport authority never follows redirects |
| Relay returns malformed/oversized data | Ignore or reject; cap each message at 1 MiB |
| Relay returns an event for another ID | Ignore |
| One relay presents a validly signed event for another ID while another has the requested event | Continue until the exact cryptographic event ID wins; an exact ID cannot name two different valid events |
| Validly signed event has conflicting duplicate tags | Reject |
| Magnet and Nostr info hash disagree | Reject before joining swarm |
| Magnet adds an extra tracker, web seed or metadata source | Rebuild from validated fields and strip unrecognised parameters |
| Torrent metadata describes multiple files | Reject in this production candidate |
| Remote endpoint uses plaintext | Reject except explicit localhost development |
| Tor-only endpoint is clearnet, v2 onion or checksum-invalid v3 onion | Reject before network access |
| Tor-only flow requests WebTorrent | Reject before the WebTorrent bundle loads |
| WebTorrent library supplies undeclared public STUN defaults | Override with an explicit empty ICE-server list; keep cross-network peer delivery unpromised |
| Web seed masks a broken browser peer path | Two-context acceptance refuses every web-seed retrieval and requires exact recovery through the WSS-signalled peer |
| File changes while the browser is seeding | Stop the seeding client and clear swarm consent before the replacement can be prepared |
| Upload or retrieval stalls | Bound the operation by a deadline; explicit cancellation aborts fetches and destroys in-flight peer clients |
| Encrypted header, record order, ciphertext or key is wrong | Reject before offering plaintext |
| Peer bytes verify but the recovery key or local decryption fails | Destroy the provisional peer client before reporting failure or permitting a clean retry; never expose a save link |
| Verified remote bytes contain executable HTML, SVG or script content | Offer only an `application/octet-stream`, `noopener` object-URL download; never navigate to or render the remote MIME type inside Wildbloom's origin |
| User changes file, endpoint, signer public key, signing method or transport profile after consent | Cancel active work and clear publication, retrieval and swarm authority; profile changes also clear the displayed external signing identity |
| Local crypto, signer or relay result finishes after that state change | Abort local hashing/crypto where possible and discard every result whose monotonic state revision is stale |
| Direct-mode signer approval finishes after a switch to Tor-only mode | Discard the signature, clear the signer identity and require a fresh Tor-profile connection |
| User withdraws Tor, upload, relay-publication or swarm consent during active work | Abort the corresponding pending work and clear downstream authority; already uploaded bytes or sent relay events cannot be retracted |
| User withdraws swarm consent after verified bytes arrive | Confirm destruction of the retained peer session before reporting that participation stopped; if cleanup cannot be confirmed, instruct the user to close the tab |

## Before any public deployment

- Complete the release gates in `docs/ACCEPTANCE.md`, including independent
  cryptographic and browser security review.
- Re-evaluate the documented WebTorrent Node-only `ip` advisory exception on
  every WebTorrent upgrade; CI fails if its browser exclusions, exact import,
  bundle contents or production module graph cross that boundary.
- Repeat the automated real-onion and branded Tor Browser gates, and exercise direct mode with a controlled live
  WebTorrent tracker and two browser peers.
- Select and disclose an operator-controlled ICE/STUN/TURN policy, or retain
  the documented host-candidate-only connectivity limit.
- Decide on relay, tracker and server policy without silently turning optional
  defaults into endorsements.
- Preserve the tested response headers at the hosting edge and add HSTS after
  the clearnet domain is proven.
