# Trusted pool storage, version 1

Preview implementation. Select **Storage layout** in the browser client.
This feature uses ordinary Blossom blobs on Wildbloom Node or compatible servers;
it does not create an autonomous storage network or promise future custody.

| Layout | Stored bytes | Recovery | Interoperability |
| --- | --- | --- | --- |
| One node | Existing single payload | That node or a manually selected existing replica | Existing NIP-94 and optional torrent workflow |
| Replicated pool | Two or three complete encrypted copies | One verified surviving copy | Blossom bytes; private Wildbloom receipt for placement and recovery |
| Split pool | `n` coded parts of the encrypted envelope | Any `k` distinct, hash-verified parts (`2 <= k < n <= 16`) | Each part is a Blossom blob; the Wildbloom client reconstructs the envelope |

For example, 2-of-4 uses approximately twice the ciphertext size and tolerates
any two missing parts. 4-of-6 uses approximately 1.5 times the ciphertext size
and tolerates any two missing parts. These are part-loss bounds; node/site
independence depends on the operator's failure-group declarations. Erasure
coding is not encryption or threshold secret sharing.

## Operator journey

1. Configure nodes to admit the chosen signing identity. Enter one URL, failure
   group and optional positive integer weight per line, e.g.
   `https://a.example site-a 2`. A weight is a relative storage allocation,
   not measured free capacity. Use the same group for nodes with shared failure
   risks. Production endpoints must have distinct hostnames; different ports
   alone do not establish independent nodes. Loopback development is exempt.
2. Choose a layout, select a file and inspect it. Pool mode requires encryption.
   Preparation, hashing and coding are local. Save the recovery key separately.
3. Approve upload and verification. First sign the private recovery receipt,
   which becomes downloadable before the first upload. Save it even if upload
   later fails. Each write still requires its own scoped, short-lived BUD-11
   authorisation. Existing bytes and uploads are checked by complete GET before
   they count. A signed receipt describes intent, not successful storage.
4. To recover in a fresh browser, load the receipt through **Use a saved signed
   event without a relay**, verify it locally, check its author and listed
   endpoints, then enter the separate key and fetch. The explicit fetch action
   permits bounded fallback among the receipt's endpoints. No discovery,
   tracker, WebRTC or relay publication is involved.
5. To repair, connect the receipt author's signer and approve **Verify and repair
   pool**. The browser recovers ciphertext without the decryption key,
   deterministically regenerates parts, verifies every regenerated hash and
   restores the selected copy counts. The browser must stay open. Too few
   verified parts is a visible failure; it never invents replacement bytes.
6. If a node is permanently lost, add an optional replacement line such as
   `1 https://replacement.example new-site 1`. The number is the one-based part
   shown in the receipt. Sign and save the new receipt. Previous destinations
   remain in the placement history and cannot be reassigned to another part.
   No old remote copy is deleted. The 16-node bound includes historical nodes;
   reaching it requires a separately designed migration or a new encrypted file.

Some Blossom stores acknowledge an already indexed hash without replacing a
corrupt on-disk copy. Read-back still detects the corruption. Repair uses an
approved spare/replacement in that case; it does not delete a shared remote
blob to force an overwrite.

The node's normal quota, writer admission and retention rules remain in force.
Configuring a node as a desired destination does not grant storage rights.
Guest or expiring friend storage is not a durable owner-storage promise.

## Placement and custody boundary

Placement uses a deterministic weighted rendezvous order for the encrypted
payload hash. Each node's score is `-ln(u)/weight`, where `u` comes from the first
48 bits of SHA-256 over `wildbloom.pool.v1\n<payload-hash>\n<canonical-origin>`,
mapped strictly inside `(0, 1)`. Nodes sharing a failure group are kept together.
Groups are assigned round-robin to coded parts. Extra groups become spare
destinations for that part. Replicated mode has one part and counts two or
three distinct groups. Assignments are saved in the receipt, not recomputed
during retrieval or repair. Nodes refuse writes exceeding their own quota;
the browser tries another approved destination for the same part.

For split storage, upload and repair send a node only its assigned part. All
reconstruction happens in the owner's browser or explicit owner repair process;
storage nodes receive neither
the complete envelope nor the recovery key through this workflow. Failure
groups and endpoints are never reused for another part within a receipt,
including replacement history. The code cannot prove distinct physical
operators or prevent collusion. Blossom reads are public to someone who knows
the hashes; a node that obtains the receipt may fetch other parts. Keep the
receipt private. Content confidentiality rests on the existing encryption.

This release has no cluster-wide free-space inventory, automatic draining,
deletion, live membership or distributed coordinator election. Explicit owner-side
unattended erasure repair is available through `wildbloomd replicas pool-repair`
(see the Node operator guide). That process must run on an owner-controlled
machine allowed to reconstruct ciphertext, separately from part storage nodes.
Weights and per-node quota fallback provide bounded
placement across the supplied pool. Ordinary node replica maintenance can
copy an existing part, but cannot regenerate an entirely lost coded part.

## Receipt contract

The receipt is a canonical, signature-verified Nostr kind 30078 local app-data
event with exactly one tag:

```json
["d", "wildbloom.pool.v1:<encrypted-envelope-sha256>"]
```

It is saved as JSON and is not published by the application. No claim is made
that it is a NIP-94 file event or a standard Blossom manifest. Receipt identity
is the signed event ID; changed placement creates a new receipt. Old receipts
remain usable with surviving old destinations, and are not silently upgraded.
Receipts have no expiry because recovery must outlive a maintenance policy.

Content uses exact, bounded fields (unknown fields are rejected):

```text
type = "wildbloom.pool"; version = 1
mode = "replicas" | "erasure"; profile = "direct" | "tor"
payload = {sha256, size, encryption: "forgesworn-aes-256-gcm-chunked-v2"}
required = k; total = n; copies = desired copies of each part
parts = [{index, sha256, size, targets: [{id, origin, failure_group, weight}]}]
```

Indices are zero-based, contiguous and ordered. Replicated mode has `k=n=1`
and `copies` of 2 or 3. Erasure mode has one copy of each of its `n` distinct
parts; redundancy is supplied by the code. SHA-256 values are lowercase hex;
origins are canonical and end with `/`. IDs/groups are 1–40 lowercase ASCII
letters, digits, underscores or hyphens; weights are integers 1–1000. There
are at most 16 destinations across a receipt, and the signed JSON is at most
128 KiB. All endpoints are validated against the selected transport before any
network action. Tor-only receipts never permit direct fallback.

Receipts contain neither the recovery key nor plaintext filename, MIME type
or hash. Save at least two independent copies of the receipt, and separately
back up the key. Lost keys cannot be recovered from parity; lost manifests
cannot be reconstructed from an arbitrary set of unlabelled Blossom objects.

## Coding contract

`wildbloom.pool` version 1 fixes the following byte layout. Changing any of it
requires a receipt-version change and new known-answer vectors.

- Encrypt first using the unchanged FSWNENC2 envelope. Let its byte length be
  `L`, and set each part's length to `S = ceil(L/k)`.
- The `k` systematic data parts are consecutive `S`-byte slices of the envelope.
  Zero-pad only the final short slice to `S` bytes.
- Work over GF(256), using primitive polynomial `0x11d` and generator 2.
  Construct the `n × k` Vandermonde matrix `V[r,c] = r^c`, for integer field
  elements `r = 0..n-1`, with column zero equal to 1 (including row zero).
- The systematic generator is `G = V × inverse(V[0..k,0..k])`.
  At each byte offset, multiply the data vector by each row of `G` to obtain
  that output part. Parity is not appended to the existing encryption envelope.
- Decode by inverting the rows of `G` corresponding to any `k` verified part
  indices. Concatenate the recovered data parts and truncate to `L`.
- Verify each part against its signed length and SHA-256 before decoding;
  verify the reconstructed envelope's length and SHA-256 before decryption;
  finally require the existing AES-GCM authentication and metadata checks.

Coding processes 64 KiB stripes and yields between them for cancellation.
The browser's existing 256 MiB source limit applies; browser-managed Blob
storage still holds the prepared parts and may consume substantial memory.
There is no claim that the maximum file size is physically accepted on every
device. No disk persistence or service worker is introduced.

The mathematical construction is consistent with the systematic Vandermonde
approach illustrated by [Backblaze's reference implementation](https://github.com/Backblaze/JavaReedSolomon/blob/master/src/main/java/com/backblaze/erasure/ReedSolomon.java).
The implementation here is independently written. Tests include a separately
computed polynomial/Lagrange vector: for input bytes 0 through 10, `k=3,n=5`,
the five parts are `[0,1,2,3]`, `[4,5,6,7]`, `[8,9,10,0]`, `[12,13,14,4]`,
and `[16,17,18,41]`.

## Validation

Run `npm run check` and, with a built current Node binary:

```sh
WILDBLOOM_NODE_BIN=/absolute/path/to/wildbloomd npm run acceptance:pool
```

The pool acceptance starts six independent local daemon processes, two explicit
replacement processes, and a real
production browser. It exercises external signing, a saved receipt, parity-only
fresh-browser recovery after two nodes stop, wrong-key rejection, repair onto
spare nodes without a recovery key, signed replacement destinations and recovery
after every original node stops. It also exercises complete-copy pool uploads.
It checks that no initial node serves the complete envelope, that native receipt
import produces separate part policies, and that no relay, peer or browser
persistence appears. These are local process tests, not independent physical
custody, maximum-size-device, public-internet or real-Tor pool acceptance.

### Unattended owner repair

Use [the Node operator guide](../../wildbloom-node/docs/POOL-STORAGE.md) to run
`wildbloomd replicas pool-repair` with the receipt, exact event ID, author public
key, expiry, private working directory and external signer. No recovery key is
needed. The browser can be closed. The service verifies surviving parts,
regenerates missing parts and uploads only to destinations already in the
signed receipt; every counted copy requires a complete verified read-back.
Add replacements and sign a new receipt in the browser, then deliberately
restart the service with that receipt's new ID. Receipt edits are never adopted
automatically. A storage node running this owner service can reconstruct the
ciphertext: do not use it on a node promised only one part.

The acceptance harness also closes all browser contexts and exercises native
parity-only repair, refusal of a changed signer return, restart without redundant
uploads, exclusive process locking, a second loss repaired by the resident
service, expiry refusal and final browser decryption of natively repaired parts.
`WILDBLOOM_BROWSER=chromium|firefox|webkit` selects installed Playwright engines;
the default is system Chromium. `--maximum` repeats the 2-of-4 and replicated journeys with a 256 MiB
source. These are automated runtime checks, not physical-device acceptance.

The **Pool storage acceptance** workflow accepts a full reviewed Node commit SHA
and runs on Linux, macOS and Windows with Chromium, Firefox and WebKit. Pull
requests use a pinned compatible Node commit; manual runs can select another
reviewed immutable commit.
It does not deploy or change any production node.

For optional real-Tor owner-process acceptance, run:

```sh
WILDBLOOM_TEST_TOR_BIN=/absolute/path/to/tor \
WILDBLOOM_NODE_BIN=/absolute/path/to/wildbloomd \
  npm run acceptance:pool -- --tor
```

This creates ephemeral onion services and tests native parity-only recovery and
repair through an explicit SOCKS proxy, with no proxy-free fallback. The normal
browser journey still runs on loopback; this option does not claim branded Tor
Browser acceptance or physical separation. Tor bootstrap and onion descriptor
availability can delay or fail the live-network test. All nodes, Tor state and
signing fixtures belong to the disposable test directory.

### Recorded local validation — 4 October 2026

- `npm run ci`: 186 tests, coverage gates, vectors, production build, production
  browser checks, secret scan and dependency audit passed (the existing,
  documented browser-unreachable dependency advisory exception remains).
- Pool browser/native journey passed in system Chromium, Playwright Firefox and
  Playwright WebKit on macOS, with eight local daemon destinations.
- Native workspace formatting, Clippy with warnings denied and tests passed:
  50 daemon tests, 24 checkout tests; the older standalone real-Tor replication
  test remains opt-in. Checkout is separately developed and is not required by
  the pool implementation.
- The pool-specific `--tor` run passed through four ephemeral real onion
  services, including missing-data regeneration from parity and refusal to run
  Tor maintenance without an explicit proxy.

The new workflow has not been run remotely. No deployment, physical-node
custody, branded Tor Browser, iPhone or Android acceptance is implied.
