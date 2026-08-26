# Architecture

Wildbloom composes existing protocols and adds a versioned local encryption
envelope. It does not introduce a storage network.

## Platform boundary

The canonical product is a static browser application. The same local-only
TypeScript core and built assets target current browsers on Windows, Linux and
macOS; the complete automated gate runs in system Chromium on all three, plus
Playwright Firefox on Linux and Playwright WebKit on macOS. This is an
application compatibility claim, not a claim that native installers,
background services, branded Firefox or real Safari have been proven.

A separate Linux Chromium gate runs two isolated production contexts against
an ephemeral TLS WebSocket tracker. Blossom retrieval is deliberately refused,
so exact recovery demonstrates real peer transport rather than a web-seed
fallback. Runtime instrumentation observes the actual empty ICE-server
configuration and host-only candidate classes. This remains same-host engine
evidence, not cross-device NAT traversal or packet-capture evidence.

Do not add a desktop shell merely for packaging. Reconsider one only if a
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
publisher --NIP-07--+------------------------------> Nostr relays
    |
    +--BUD-11 scoped auth--> Blossom server --SHA-256 URL--+
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
   exact server hostname, exact SHA-256 and a 90-second lifetime.
4. The browser uploads the unchanged bytes with BUD-02 and rejects a descriptor
   whose URL, hash or size differs.
5. In direct mode it creates a one-file BitTorrent v1 descriptor containing
   the Blossom URL as a web seed and user-selected WebSocket trackers.
   WebTorrent receives an explicit empty ICE-server list; it must not inherit
   library-supplied public STUN/TURN infrastructure.
6. The signer signs a NIP-94 file event and, in direct mode, a NIP-35 torrent
   index. The encryption scheme is an explicit versioned extension tag.
7. Only the explicit publish action sends those events to chosen relays.

Seeding is deliberately independent from relay publication. A Blossom-backed
magnet remains useful without the publisher becoming a peer, while a live
publisher can explicitly add peer capacity. The current host-candidate-only
WebRTC policy favours a truthful network-authority boundary over silent NAT
traversal. Internet peer delivery needs a separately reviewed ICE design.

Tor-only mode is a separate branch. It validates v3 onion checksums, accepts
only onion Nostr and Blossom endpoints, omits the torrent entirely and refuses
WebRTC. It has no automatic fallback to the direct branch.

## Retrieval

1. Query chosen relays by an exact 64-hex event ID.
2. Accept only a valid kind `1063` event with a valid Nostr signature.
3. Require exactly one URL, MIME type, SHA-256 and byte count. Magnet and info
   hash must either both be absent or both be present.
4. When present, rebuild the magnet from the signed hash, exact byte count,
   exact Blossom web seed and validated trackers. Ignore no extra transport
   parameters.
5. For Blossom, stream no more than the signed byte count and verify SHA-256.
6. For BitTorrent, require a one-file torrent with the signed info hash and
   byte count, then verify the resulting file's SHA-256 too.
7. For an encrypted envelope, authenticate every chunk and reveal the source
   filename and bytes only after the complete envelope succeeds.

## Deliberate omissions

- No server defaults, analytics, accounts, local persistence or service worker.
- No raw key input or app-held signing key.
- No multi-file torrents.
- No password-derived keys or server-side key recovery.
- No claim that deleting a relay event retracts metadata or replicated bytes.
- No automatic fallback from a privacy-preserving transport to clearnet.
