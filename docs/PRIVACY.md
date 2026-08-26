# Privacy model

Wildbloom separates content confidentiality from network-location privacy.
Neither control implies the other.

## Direct encrypted delivery

The source content, filename and MIME type are encrypted locally before any
network request. The public Nostr event, Blossom descriptor and torrent refer
only to the randomised encrypted envelope. The recovery key must be shared
through a separate trusted channel. A protected NIP-94 event's `x` and `ox`
tags both cover the randomised encrypted envelope, which is the unchanged file
given to the upload server. Neither tag contains a plaintext source fingerprint.

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

Use Tor Browser rather than configuring an ordinary browser with a Tor SOCKS
proxy. A normal browser does not acquire Tor Browser's anti-fingerprinting
behaviour, and HTTP onion origins may not be treated as secure contexts with
Web Crypto available. Wildbloom does not apply a production secure-origin
override to disguise that failure.

The automated transport gate does use a real Tor daemon and fresh v3 onion
services for the app, Blossom and relay. It proves the application has no
clearnet or WebRTC fallback in that controlled run. Because stock Chromium
needs a test-only secure-origin override, an extended gate rotates identity and
repeats signer-free retrieval in a signed branded Tor Browser binary. The
first disposable profile also completes exact external-signature publication
without a signer extension; after `NEWNYM`, a second profile performs the
retrieval ceremony. Both use loopback-only WebDriver BiDi. This is automated
content-engine evidence, not a claim that headless automation has the same
fingerprint as ordinary Tor Browser use.

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

External signer handoff avoids adding code to Tor Browser. Wildbloom shows one
exact unsigned event, accepts only a strict valid signature over those fields,
and never contacts the signer. The transfer medium and signer still see the
intended public event, service and signing identity; a reused identity, online
signer or synchronised clipboard can destroy unlinkability. This is a custody
and fingerprint improvement, not proof of anonymous publication. See
[`EXTERNAL-SIGNING.md`](EXTERNAL-SIGNING.md).

Changing network profile or withdrawing Tor confirmation clears Wildbloom's
connected signer identity and requires an explicit connection again. A signer
approval that completes from the previous profile is discarded. This prevents
stale direct-mode events from becoming publishable in Tor-only state, but it
cannot make a reused Nostr key or the signer's own network activity anonymous.

## Browser state

Wildbloom does not persist application data in cookies, local or session
storage, IndexedDB, Cache Storage or a service worker. Production browser
acceptance checks those stores after complete publication and retrieval
journeys, and records any attempted mutation of their persistent APIs. Peer
acceptance also plants a pre-existing `localStorage.debug` preference and proves
that WebTorrent neither consumes nor changes it; this prevents a stale browser
setting from enabling dependency diagnostics in production.

Secret and machine-formatted controls ask the browser not to autofill,
autocapitalise, autocorrect, spellcheck or translate their values. The response
Permissions-Policy denies Clipboard API reads and writes; ordinary deliberate
copy and paste through browser or operating-system controls still works. These
are browser hints and containment controls, not secure deletion: a browser,
extension, input method, clipboard manager or operating system may retain or
synchronise data outside Wildbloom's control. Close the tab after use.

Navigating away ends the page session: Wildbloom invalidates pending results,
aborts active work, starts peer cleanup, clears file and endpoint selections,
recovery material, external-signing JSON, signer identity and every consent,
then revokes its object URLs. A browser that restores the document from its
back-forward cache is forced to create a fresh document rather than reviving
the old JavaScript heap. Browser acceptance exercises both the page-lifecycle
event and a real navigation away and back. Browser, operating-system and
extension copies remain outside Wildbloom's secure-deletion control.

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
