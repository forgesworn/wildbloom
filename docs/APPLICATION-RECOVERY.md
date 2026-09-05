# Recovering after losing a browser or storage server

Wildbloom keeps its session in page memory. A new browser can recover an
encrypted file using the signed discovery event and the separately retained
file recovery key. Publication can use the exact external-signing handoff;
retrieval does not require access to the publishing signer.

Keep these outside the browser before relying on recovery:

- The saved signed file-event JSON, or its Nostr event ID and a relay retaining
  that signed event. **Save signed file event** is available after signing,
  before any relay publication, and after verifying an event from a relay.
- The exact `wbk1_` recovery key saved before upload.
- A reachable Blossom server holding the encrypted bytes. If the original
  server may disappear, first arrange and verify a copy elsewhere, and keep
  that server's origin privately where appropriate.

The file key is random and independent of the signing identity. Identity
recovery words cannot reconstruct a lost file key. A relay event locates and
authenticates the file; it does not hold the file or guarantee a replica.

## Restore from an existing replica

1. Open Wildbloom in the fresh browser and choose the appropriate network
   profile. Tor-only retrieval requires a correctly configured Tor browser
   and checksum-valid v3 onion endpoints throughout.
2. If the original Blossom server is unavailable, enter the other server's
   origin in **Another Blossom server** before verifying the event.
3. For relay discovery, enter the relay and Nostr event ID, then choose
   **Resolve signed event**. For saved discovery, expand **Use a saved signed
   event without a relay**, load the saved JSON file or paste its contents,
   then choose **Verify saved event locally**. Check the verified author and
   file information. If an event ID is supplied, the saved event must match it.
4. Enter the separately retained recovery key, then choose **Fetch and verify
   from Blossom**. Save the verified local file.

An explicit replica is requested through standard BUD-01 `GET /<sha256>`.
The original signed event is unchanged. Wildbloom checks its signed byte
count and SHA-256 before authenticated decryption; it refuses redirects and
uses the selected network profile. Choosing a server makes no request and
invalidates previous network consent. Verify the event again after changing
it. The choice is cleared on navigation and network-profile changes.

The fetch action contacts the chosen server, which sees connection metadata
and the requested hash. It does not create another copy, discover other
holders or fall back to a different origin. Successful retrieval verifies
that copy at that time. Replica policy, ongoing repair and retention remain
separate application responsibilities.

## Saved discovery events

The download contains only the canonical signed Nostr event. It contains public
metadata, not file bytes or the recovery key. It can be retained and exchanged
without publishing it to a relay. A new browser needs no publishing signer to
verify it. A signature authenticates its author key; match the event ID or
author against a trusted source when accepting an event from someone else.

File import is limited to 128 KiB before reading. JSON import also checks its
UTF-8 byte size, canonical fields, signature and the same file, hash, size,
encryption and endpoint rules used for relay discovery. Loading and verifying
are local actions. They never query a relay, fetch a file or join a swarm.
Tor-only endpoint rules still apply; an actual fetch additionally requires
Tor confirmation. Changing the imported event cancels retrieval and clears
previous consents and save links. Navigation or a profile change clears the
imported JSON and file selection, including any unfinished file read.

## Automated acceptance

Build the reviewed Wildbloom Node source and the browser production bundle,
then run:

```sh
npm run build
WILDBLOOM_NODE_BIN=/path/to/wildbloomd npm run acceptance:recovery
```

The harness creates two separate real Node processes and fresh data stores,
bound only to loopback with Tor disabled. A synthetic signer outside the
browser completes the normal JSON handoff. With the tracker list left empty,
the browser uploads encrypted bytes and publishes one signed NIP-94 event to
a controlled relay. No torrent metadata, torrent signature or peer connection
is needed. Before publication, it saves the actual exported signed event.
The harness creates an authorised second copy, closes the entire publisher context, stops the
original node and restarts the replica from disk.

A fresh signer-free browser must fail at the unavailable original, recover
the exact file from the explicitly chosen replica, reject a wrong key,
reject deliberate disk corruption, clear stale downloads and retain no
browser persistence. It must make no implicit peer connection or contact an
undeclared origin. A further fresh browser recovers from the saved event after
the discovery relay stops, with no relay configuration, signer or WebSocket
connection. The imported event is verified without HTTP requests, then a
separate fetch recovers exact bytes from the chosen replica. Cleanup terminates
the fixtures and removes their stores.

The CI workflow pins Node source `cbbfdcd5f923527a30a2ea1a146b4beed0d21ade`
and Rust 1.94.1. Its redacted record contains browser asset hashes, source
revision, Node binary hash/version, browser version and the checks completed.
It contains no file key, private signing material or source file contents.

This is automated process and browser evidence on one host. Physical-device
failure, real external-signer custody, independent review and an ongoing
replica-count/repair policy remain open acceptance gates.
