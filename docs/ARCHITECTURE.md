# Architecture

Wildbloom composes existing protocols rather than introducing a fourth one.

```text
                         signed NIP-94 event
                    + URL + SHA-256 + magnet + infohash
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

1. The browser validates the file size and sanitises its display name.
2. It computes SHA-256 locally.
3. The NIP-07 signer signs a kind `24242` BUD-11 upload token scoped to the
   exact server hostname, exact SHA-256 and a 90-second lifetime.
4. The browser uploads the unchanged bytes with BUD-02 and rejects a descriptor
   whose URL, hash or size differs.
5. It creates a one-file BitTorrent v1 descriptor containing the Blossom URL as
   a web seed and user-selected WebSocket trackers.
6. The signer signs a NIP-94 file event and NIP-35 torrent index.
7. Only the explicit publish action sends those events to chosen relays.

Seeding is deliberately independent from relay publication. A Blossom-backed
magnet remains useful without the publisher becoming a peer, while a live
publisher can explicitly add peer capacity.

## Retrieval

1. Query chosen relays by an exact 64-hex event ID.
2. Accept only a valid kind `1063` event with a valid Nostr signature.
3. Require exactly one URL, MIME type, SHA-256, byte count, magnet and info hash.
4. Require the magnet's v1 info hash to match the signed `i` tag.
5. For Blossom, stream no more than the signed byte count and verify SHA-256.
6. For BitTorrent, require a one-file torrent with the signed info hash and
   byte count, then verify the resulting file's SHA-256 too.

## Deliberate omissions

- No server defaults, analytics, accounts, local persistence or service worker.
- No raw key input or app-held signing key.
- No multi-file torrents.
- No client-side encryption yet.
- No claim that deleting a relay event retracts metadata or replicated bytes.
- No automatic fallback from a privacy-preserving transport to clearnet.
