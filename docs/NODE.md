# Wildbloom Node

[Wildbloom Node](https://github.com/forgesworn/wildbloom-node) is the native,
self-hosted half of the Wildbloom idea. The browser encrypts and signs. The node
stores the resulting Blossom blob on the operator's disk and serves it through
a stable Tor v3 onion.

The separation is deliberate:

- no Nostr secret or recovery key enters the node;
- the browser remains a static app with no background or filesystem authority;
- the node can stream large blobs to disk, reserve quota and remain available
  after the browser closes;
- both halves remain compatible with ordinary Blossom clients and servers.

## Home networking

The node binds to loopback and starts Tor itself. Tor supplies the inbound onion
route and an internal outbound path for replication, so the operator does not
open a firewall port or configure NAT. There is no WebRTC, STUN or TURN in the
node.

For the browser's Tor-only profile, open Wildbloom through Tor Browser and enter
the node's `.onion` URL as the Blossom server. Wildbloom signs a short-lived
BUD-11 event for that exact hostname and hash, uploads only the prepared
ciphertext, and verifies the returned descriptor.

## Replication

`PUT /mirror` uses standard BUD-04. A destination node receives a signed upload
authority and a hash-addressed source URL, fetches it through Tor, reserves
quota before reading the body, and independently checks its length and SHA-256.
Each replica stores the complete blob today. This is closer to deliberate
Blossom pinning than BitTorrent chunk swarming.

The current macOS prototype has exercised two independent node processes: node
B mirrored through node A's onion, A stopped, and B still served the exact
bytes. That proves the tested copy survived that source loss. It does not prove
future custody, automatic repair or Windows/Linux Tor runtime.

## Why it still needs Nostr

Nostr is useful for signed discovery, server lists and private storage offers.
It does not carry the file and a relay acknowledgement does not prove custody.
Once a Blossom endpoint is known, upload, mirroring and retrieval continue over
HTTP/Tor without a relay.

RelaySwarm may later provide a faster Noise-authenticated direct transport. It
must remain optional, with standard Blossom over Tor as the compatible path.

