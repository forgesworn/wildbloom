# Privacy model

Wildbloom separates content confidentiality from network-location privacy.
Neither control implies the other.

## Direct encrypted delivery

The source content, filename and MIME type are encrypted locally before any
network request. The public Nostr event, Blossom descriptor and torrent refer
only to the randomised encrypted envelope. The recovery key must be shared
through a separate trusted channel.

This profile still reveals:

- the Nostr public key, event time and chosen endpoints;
- the padded ciphertext size and a randomised ciphertext SHA-256;
- the user's IP address and timing to relays, Blossom, trackers and peers;
- that the same ciphertext is being requested or seeded;
- browser and signer characteristics visible to those services.

Wildbloom overrides WebTorrent's inherited public Google and Twilio STUN
defaults with an empty ICE-server list. Peer mode therefore makes no undeclared
STUN/TURN request, but host candidates still expose network addresses to a peer
and cross-network connectivity may fail. Any future public ICE service must be
operator-selected, disclosed beside the action and covered by packet evidence.

## Tor-only encrypted delivery

Tor-only mode accepts only exact checksum-valid v3 `.onion` hostnames for
Nostr relay and Blossom traffic. It rejects clearnet endpoints, redirects,
trackers and WebTorrent. It never falls back to the direct profile.

This is the correct Tor boundary because the Tor Project explicitly says not
to torrent over Tor, while browser WebTorrent uses WebRTC for peer transport.
Tor onion services provide end-to-end encrypted TCP connections, but the app
cannot inspect the browser's proxy configuration and therefore cannot prove
that Tor is in use.

The automated transport gate does use a real Tor daemon and fresh v3 onion
services for the app, Blossom and relay. It proves the application has no
clearnet or WebRTC fallback in that controlled run. Because stock Chromium
needs a test-only secure-origin override and is not Tor Browser, branded Tor
Browser interaction remains separate acceptance evidence.

Primary guidance:

- [Tor Browser safety and the torrent warning](https://support.torproject.org/tor-browser/security/using-tb-safely/)
- [Tor Browser add-on and fingerprinting warning](https://support.torproject.org/tor-browser/features/plugins/)
- [Onion-service security properties](https://support.torproject.org/tor-browser/features/onion-services/)
- [WebTorrent browser transport](https://github.com/webtorrent/webtorrent#readme)

## Signer boundary

NIP-07 preserves signing-key custody, not anonymity. A signer can reveal a
stable public key, contact its own remote service, alter the Tor Browser
fingerprint or present misleading approval UI. Tor Browser users are strongly
discouraged from installing extra add-ons.

Until Wildbloom has an independently reviewed extension-free signing path,
Tor-only publication is a network-transport control rather than a claim of
anonymous publication. Tor-only retrieval does not need a signer.

## Operational rules

- Do not send the event ID and recovery key through the same observable
  channel when separation matters.
- Use a fresh Nostr identity when linkability to an existing identity is not
  acceptable.
- Do not paste recovery keys into issues, relay events, server logs or URLs.
- Close the tab after use; keys are intentionally kept only in page memory.
- Use a new Tor Browser identity between unrelated activities when the threat
  model calls for circuit and state separation.
- Treat server, relay and reverse-proxy logs as sensitive even when content is
  encrypted.

## Not promised

Wildbloom does not promise anonymity, traffic-analysis resistance,
deniability, secure deletion, endpoint availability, protection from a
compromised browser or signer, or recovery after losing the key.
