# Architecture

Wildbloom composes existing protocols and adds a versioned local encryption
envelope. The browser application does not allocate storage or introduce a
storage network. [Wildbloom Node](https://github.com/forgesworn/wildbloom-node)
is the separate native project which turns an operator's disk into a standard
Blossom server and replicates complete blobs between nodes.

## Platform boundary

The canonical product is a static browser application. The same local-only
TypeScript core and built assets target current browsers on Windows, Linux and
macOS; the complete automated gate runs in system Chromium on all three, plus
Playwright Firefox on Linux and Playwright WebKit on macOS. This is an
application compatibility claim, not a claim that native installers,
background services or real Safari have been proven.

A separate Linux Chromium gate runs two isolated production contexts against
an ephemeral TLS WebSocket tracker. Blossom retrieval is deliberately refused,
so exact recovery demonstrates real peer transport rather than a web-seed
fallback. Runtime instrumentation observes the actual empty ICE-server
configuration and host-only candidate classes. This remains same-host engine
evidence, not cross-device NAT traversal or packet-capture evidence.

A separate branded-Mozilla-Firefox gate uses two independent browser processes
and profiles. An extension-free publisher supplies exact external signatures,
then a signer-free downloader recovers the exact source through their WebRTC
connection while the published Blossom object is unavailable. It observes the
same empty ICE-server configuration and host-only candidates, and requires both
peer sessions to leave the tracker after consent withdrawal and source change.
The tracker certificate is disposable harness material accepted only by those
automated browser sessions.

An on-demand system-Chrome gate completes encryption, Blossom upload, signed
publication, exact relay resolution, verified download and decryption at the
exact 256 MiB source limit under a constrained V8 heap, and refuses 256 MiB
plus one byte. Chunked cryptography keeps individual plaintext buffers to 1 MiB,
but source and encrypted `Blob` storage is browser-managed and may live outside
the JavaScript heap. This is not a claim that low-memory operating systems or
devices have been proven.

Do not add a desktop shell to the browser application merely for packaging.
Wildbloom Node already owns the native background-service boundary. Reconsider
a browser-app shell only if a
validated requirement needs native streaming for very large files, reliable
background seeding, OS key storage or a separately designed bundled-Tor
process. A Tauri spike must prove the exact crypto, WebSocket, WebRTC, download
and accessibility paths in Windows WebView2, macOS WKWebView and Linux
WebKitGTK before adoption; those engines do not have identical behaviour.
Electron is a fallback only if a pinned Chromium runtime materially solves a
proven compatibility problem and its Node/IPC capability surface passes a
separate security review.

Platform references:

- [Tauri system webview versions](https://tauri.app/reference/webview-versions/)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Playwright browser boundaries](https://playwright.dev/docs/browsers)

```text
 source --local AES-GCM--> padded encrypted envelope
                    |
                    +---- recovery key leaves only out of band
                    |
                         signed NIP-94 event
                    + encrypted URL + SHA-256 + optional magnet/infohash
                    |
publisher --NIP-07 or exact external signature----> Nostr relays
    |
    +--BUD-11 scoped auth--> Blossom / Wildbloom Node --SHA-256 URL--+
    |                                                       |
    +--WebTorrent seed----------> tracker/peers <------------+
                                                            web seed
retriever --verify event--> choose Blossom GET or swarm --> verify bytes
```

## Publication

1. The browser validates and hashes the source locally.
2. By default it creates a random key, encrypts the content and private
   metadata in authenticated chunks, pads the envelope, and hashes only that
   public transfer payload.
3. The NIP-07 signer signs a kind `24242` BUD-11 upload token scoped to the
   exact server hostname, exact SHA-256 and a 90-second lifetime. External
   handoff presents the same exact template and allows five minutes for a
   deliberate cross-device ceremony; the returned event must have the expected
   author, exact fields and a valid signature.
4. The browser uploads the unchanged bytes with BUD-02 and rejects a descriptor
   whose URL, hash or size differs.
5. In direct mode it creates a one-file BitTorrent v1 descriptor containing
   the Blossom URL as a web seed and user-selected WebSocket trackers.
   WebTorrent receives an explicit empty ICE-server list; it must not inherit
   library-supplied public STUN/TURN infrastructure.
6. NIP-07 or the external handoff signs a NIP-94 file event and, in direct
   mode, a NIP-35 torrent index. The encryption scheme is an explicit versioned extension tag.
   For protected events, `x` and NIP-94's pre-upload-server-transformation
   `ox` both hash the randomised encrypted envelope. Neither may contain the
   plaintext source hash, which would create a confirmation oracle. The URL,
   MIME type and size likewise describe only the encrypted public envelope.
7. Only the explicit publish action sends those events to chosen relays.

Seeding is deliberately independent from relay publication. A Blossom-backed
magnet remains useful without the publisher becoming a peer, while a live
publisher can explicitly add peer capacity. The current host-candidate-only
WebRTC policy favours a truthful network-authority boundary over silent NAT
traversal. Internet peer delivery needs a separately reviewed ICE design.

Tor-only mode is a separate branch. It validates v3 onion checksums, accepts
only onion Nostr and Blossom endpoints, omits the torrent entirely and refuses
WebRTC. It has no automatic fallback to the direct branch. A separate real-Tor
gate runs the production app, controlled Blossom service and controlled Nostr
relay as three disposable v3 onion services, rotates identity between fresh
browser contexts and requires exact encrypted recovery. Its Chromium
secure-origin override is test scaffolding, not part of the production build
and not branded Tor Browser evidence. An extended gate rotates identity again
and drives an actual signed Tor Project Firefox build through loopback-only
WebDriver BiDi. A disposable profile performs exact external-signature upload
and publication without an add-on or WebRTC. After `NEWNYM`, a second fresh
profile performs signer-free exact retrieval, relay-timeout,
download-cancellation and denied-service checks. This does not prove manual Tor
Browser usability or fingerprint equivalence.

## Retrieval

1. Query chosen relays by an exact 64-hex event ID.
2. Accept only a valid kind `1063` event with a valid Nostr signature.
3. Require exactly one URL, MIME type, `x`, `ox` and byte count, with both
   SHA-256 tags identifying the same unchanged bytes. Magnet and info hash must
   either both be absent or both be present.
4. When present, rebuild the magnet from the signed hash, exact byte count,
   exact Blossom web seed and validated trackers. Ignore no extra transport
   parameters.
5. For Blossom, stream no more than the signed byte count and verify SHA-256.
6. For BitTorrent, require a one-file torrent with the signed info hash and
   byte count, then verify the resulting file's SHA-256 too.
7. For an encrypted envelope, authenticate every chunk and reveal the source
   filename and bytes only after the complete envelope succeeds.
8. Offer verified bytes only through an octet-stream, `noopener` save link.
   Blob URLs inherit the creating page's origin, so remote MIME types are never
   allowed to become navigable HTML or SVG within Wildbloom's authority.

## Deliberate omissions

- No server defaults, analytics, accounts, local persistence or service worker.
- No raw key input or app-held signing key.
- No multi-file torrents.
- No password-derived keys or server-side key recovery.
- No claim that deleting a relay event retracts metadata or replicated bytes.
- No automatic fallback from a privacy-preserving transport to clearnet.

## Asynchronous authority

Publication and retrieval state use monotonic revisions. File, endpoint,
signing method, external public key, event-ID, consent or profile changes abort
the relevant controllers and clear downstream state. Hashing and envelope
cryptography check cancellation between bounded chunks; signer results and
other operations that cannot be interrupted are committed only if their
captured revision still matches. Switching to or from Tor also clears the
connected and displayed signer identity. This prevents an older direct-mode
result from repopulating or becoming publishable in newer Tor-only state.

Relay publication is irreversible once a relay has received an event.
Cancellation closes pending sockets and discards stale acknowledgements; it is
not a retraction mechanism.

Relay discovery does not use `nostr-tools` pools or long-running subscriptions.
Each deliberate exact-ID lookup opens its own WebSocket, sends one bounded
`REQ`, and has a ten-second deadline. Success, `EOSE`, failure, cancellation or
timeout sends `CLOSE` when possible and closes the socket. Wildbloom imports
only the `nostr-tools/pure` event-validation primitives; relay lifecycle remains
inside the injected, directly tested boundary above.
