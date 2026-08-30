# Cross-device WebTorrent acceptance

This ceremony closes one narrow release gate: two physical browsers recover the
same encrypted file through a direct WebRTC peer connection on an isolated IPv4
LAN while the controlled Blossom object is unavailable. A packet capture must
show both devices reaching the exact HTTPS/WSS coordinator, direct peer UDP and
no other device flows beyond explicitly declared DNS and mDNS.

It does not prove NAT traversal, internet-wide reachability, anonymity or the
absence of traffic outside the capture window. Wildbloom still supplies an
empty ICE-server list. Peer-to-peer ICE connectivity checks may use STUN-format
packets directly between the two devices; that is not contact with a public
STUN service.

## Privacy boundary

The raw packet capture contains LAN addresses, ports, timing and traffic
volume. The running coordinator sees the same network addresses through its
TLS proxy. It converts them to per-run salted aliases and never writes the
addresses or salt. It also never persists upload bytes, authorisation headers,
signed-event JSON, recovery keys or the fixture URL token.

Keep the raw capture and coordinator console private. The schema-validated
final JSON contains only aliases and aggregate packet counts. That redaction
reduces evidence retention; it does not undo disclosure to the two browsers,
the LAN or the capture operator.

## Equipment and network

Use:

- one clean checkout of the exact commit under test;
- two physical devices with current WebRTC-capable browsers;
- a NIP-07 signer on the publishing device, or a separate signer capable of the
  documented exact JSON handoff;
- an isolated, quiescent IPv4 Wi-Fi network with peer isolation disabled;
- Caddy and `tcpdump` on the coordinator host; and
- a LAN DNS name which resolves only to that host during the run.

Disable cellular data, VPNs, private relay features and unrelated applications
on both devices for this bounded test. Do not weaken Wildbloom to accept HTTP,
an invalid certificate or a hidden ICE service. If the network cannot be made
quiet enough for the fail-closed packet check, record that as a failed run.

## Prepare trusted LAN TLS

Map an operator-chosen DNS name such as `wildbloom-test.example` to the
coordinator's LAN IPv4 address on both devices. The example uses TCP port 8443
so Caddy does not need privileged port binding.

Build the exact production files from a clean checkout:

```sh
npm ci
npm run build
```

Create a private evidence directory outside the repository:

```sh
WILDBLOOM_CROSS_DEVICE_DIR="$(mktemp -d)"
chmod 700 "$WILDBLOOM_CROSS_DEVICE_DIR"
```

In terminal one, start the loopback-only coordinator. Substitute the DNS name
if a different one was chosen:

```sh
npm run acceptance:cross-device:serve -- \
  --public-origin https://wildbloom-test.example:8443 \
  --evidence "$WILDBLOOM_CROSS_DEVICE_DIR/service.json"
```

The coordinator refuses a dirty worktree, a raw-IP public origin and an
existing evidence path. It
prints a one-run public-fixture URL plus the exact Blossom, relay and tracker
values. It never generates or accepts signing credentials.

In terminal two, start Caddy:

```sh
WILDBLOOM_TEST_HOST=wildbloom-test.example \
WILDBLOOM_TEST_TLS_PORT=8443 \
caddy run --config docs/cross-device/Caddyfile.example --adapter caddyfile
```

The template skips Caddy's automatic local trust-store installation so startup
never invokes `sudo` unexpectedly. It overwrites `X-Forwarded-For` with the
actual client address.
The coordinator trusts that header only because it binds exclusively to
`127.0.0.1`.

With Caddy still running, use terminal three to perform the deliberate local
trust action. This may request the coordinator user's administrator approval:

```sh
caddy trust
```

Export only the public root certificate from Caddy's loopback admin API. Do not
export Caddy's storage, which also contains the authority's private key:

```sh
curl --fail --silent --show-error http://127.0.0.1:2019/pki/ca/local \
  | node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).root_certificate' \
  > "$WILDBLOOM_CROSS_DEVICE_DIR/caddy-local-root.crt"
```

Install only `caddy-local-root.crt` as a trusted test CA on both physical
devices. The authority's private key must stay on the coordinator. Check the
`/healthz` URL in each ordinary browser and require a valid secure origin, then
close those tabs. Remove the test CA from both devices after the ceremony.

## Capture and browser ceremony

Record the publisher, downloader and coordinator IPv4 addresses. Start the
capture before opening the site, replacing `en0` and the two device addresses:

```sh
sudo tcpdump -i en0 -U -n -s 128 \
  -w "$WILDBLOOM_CROSS_DEVICE_DIR/cross-device.pcap" \
  '(host 192.0.2.10 or host 192.0.2.11)'
```

On the publisher only:

1. Download the one-run fixture URL printed by the coordinator. Do not send or
   open that URL on the downloader.
2. Open the printed application URL. Choose **Direct encrypted delivery**.
3. Enter the printed HTTPS origin as Blossom server, the `/relay` WSS URL as
   Nostr relay and the `/announce` WSS URL as WebTorrent tracker.
4. Connect a NIP-07 signer after the deliberate button press, or use the exact
   external-signer JSON handoff. Never enter a private key or `nsec`.
5. Keep encryption enabled, select the downloaded fixture and choose **Inspect
   locally**. Save and acknowledge the recovery key through a separate private
   transfer medium.
6. Acknowledge the upload disclosure and choose **Upload prepared payload**.
7. Acknowledge the swarm disclosure and choose **Start peer seeding**.
8. Choose **Review and sign events**, complete any exact external handoffs, then
   acknowledge and choose **Publish signed events**.
9. Transfer only the public NIP-94 event ID and recovery key to the downloader.
   Keep the publishing page seeding.

On the downloader:

1. Open the application URL directly; do not fetch the fixture URL.
2. Enter the same Blossom, relay and tracker endpoints. No signer is needed.
3. Enter the NIP-94 event ID and choose **Resolve signed event**.
4. Enter the recovery key, acknowledge the swarm disclosure and choose **Join
   swarm and verify**. Do not choose the Blossom retrieval button.
5. Save the verified recovered file from Wildbloom's download link.

Withdraw the downloader's swarm consent, stop publisher seeding and confirm
both pages report that the peer action stopped. Stop `tcpdump`, then stop the
coordinator with `Ctrl-C`. The coordinator records its end time and verifies
that no peer remains in its final snapshot.

## Verify and redact

Hash and measure the recovered file independently. On macOS:

```sh
shasum -a 256 /path/to/recovered-file
stat -f %z /path/to/recovered-file
```

Run the fail-closed verifier. Add `--dns-ip ADDRESS` once for each DNS server
observed in the isolated capture; omit it when DNS was resolved before capture.

```sh
npm run acceptance:cross-device:verify -- \
  --service-evidence "$WILDBLOOM_CROSS_DEVICE_DIR/service.json" \
  --capture "$WILDBLOOM_CROSS_DEVICE_DIR/cross-device.pcap" \
  --publisher-ip 192.0.2.10 \
  --downloader-ip 192.0.2.11 \
  --coordinator-ip 192.0.2.12 \
  --coordinator-port 8443 \
  --recovered-sha256 REPLACE_WITH_LOWERCASE_SHA256 \
  --recovered-size 524288 \
  --output "$WILDBLOOM_CROSS_DEVICE_DIR/final.json"
```

Passing requires one exact clean source commit, one encrypted upload, valid and
consistent BUD-11/NIP-94/NIP-35 signatures, an exact-ID lookup by the second
device, two concurrent tracker participants, zero Blossom blob bytes served,
no active peer at shutdown, direct peer UDP, no undeclared captured endpoint
and an exact fixture recovery hash and size.

Retain `final.json` with the release record. Keep `service.json` and the raw
capture in restricted storage only as long as the review policy requires; do
not commit either file. Delete the downloaded fixture, recovered file and raw
capture when the review record no longer needs them, and remove the test CA
from both devices.
