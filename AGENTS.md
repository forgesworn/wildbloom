# AGENTS.md - Wildbloom

These instructions apply to the whole repository.

## Purpose

Wildbloom is a local-first browser production candidate for publishing and retrieving the
same file through three existing protocols: Nostr for signed discovery,
Blossom for content-addressed HTTP delivery, and BitTorrent/WebTorrent for peer
delivery. It is interoperability work, not a new storage network.

## Commands

- `npm run check`: runs, in order and stopping at the first failure,
  `install:policy`, `encryption:vector`, `encryption:semantic-vectors`,
  `acceptance:cross-device:self-test`, `test:checkout-preflight`, `typecheck`,
  `test:coverage`, `build`, `acceptance:deployment`, `smoke:browser`,
  `acceptance:storage-discovery` and `secrets`
- `npm run ci`: `check` followed by `audit`. `audit` runs `npm audit --json`
  over all dependencies (production and development) at every severity and
  fails on any advisory except `GHSA-2p57-rm9w-gvfp`, the `ip` advisory reached
  only through WebTorrent's Node-only UDP tracker parser, which is accepted
  only while the reachability guard in `scripts/audit.mjs` still holds
- `npm run smoke:browser:firefox`: the production journey in installed Playwright Firefox
- `npm run smoke:browser:webkit`: the production journey in installed Playwright WebKit
- `npm run smoke:swarm`: two isolated Chromium contexts transferring through a controlled TLS WebSocket tracker
- `npm run acceptance:get`: recipient page `/get` in Chromium against a real pairing service and synthetic storage; requires `FOREGATHER_SERVER_BIN`
- `npm run acceptance:direct`: the phone page `/send` (Chromium emulating Android Chrome) sends a file straight to a test receiver in a second Chromium, through a real pairing service; relay-only through a real coturn when `turnserver` is installed; requires `FOREGATHER_SERVER_BIN`
- `npm run acceptance:recovery`: fresh-browser recovery from a restarted real Node replica after the original node stops; requires `WILDBLOOM_NODE_BIN`
- `npm run acceptance:pool:quick`: disposable local nodes, threshold recovery and repeated automatic owner repair; requires a production build and `WILDBLOOM_NODE_BIN`
- `npm run dev`: local Vite development server
- `npm run serve:production`: loopback static server with production response headers

### All npm scripts

Every script in `package.json`. "Needs a build" means `npm run build` must have
produced `dist/` first. Browser gates default to a system Chrome, Chromium,
Brave or Edge executable unless the row says otherwise. Run scripts that take
flags as `npm run <script> -- <flags>`.

| Script | Purpose | Needs |
| --- | --- | --- |
| `dev` | Vite development server | nothing |
| `build` | `tsc --noEmit` then `vite build` into `dist/` | nothing |
| `build:cloudflare` | `build`, then writes `dist/_headers` and `dist/healthz` for Cloudflare Pages | refuses to overwrite either file, so start from a fresh build |
| `preview` | Vite preview of `dist/`; not the production server or its headers | a build |
| `serve:production` | loopback static server with production headers, `/healthz` and a bounded startup snapshot | a build; flags `--host`, `--port`; `WILDBLOOM_ALLOWED_HOSTS` (comma-separated hostnames, default `localhost,127.0.0.1,<host>`) |
| `release:evidence` | emits release evidence JSON (source commit, lock hash, build hash, per-file SHA-256 and length) | a build, a git checkout and npm; flags `--require-clean`, `--output <path>`; `--output` refuses an existing file and any path inside `dist/` |
| `build:compare` | compares two to eight release-evidence files for an identical build at one commit | flags `--expect-commit <40 hex>` and repeated `--input label=path` |
| `verify:deployment` | read-only probe of a deployed origin against release evidence | flags `--origin` and `--evidence` (required), `--output`, `--allow-loopback`; network access |
| `acceptance:deployment` | adversarial acceptance of the production server and deployment verifier | a build |
| `smoke:browser` | production journey in a real browser | a build; `--browser` or `WILDBLOOM_BROWSER` of `system-chromium` (default), `chromium`, `firefox` or `webkit` |
| `smoke:browser:firefox` | `smoke:browser --browser firefox` | a build; Playwright Firefox installed |
| `smoke:browser:webkit` | `smoke:browser --browser webkit` | a build; Playwright WebKit installed |
| `smoke:swarm` | two isolated Chromium contexts through a controlled TLS WebSocket tracker, with Blossom web seeds refused | a build; `--browser` or `WILDBLOOM_BROWSER` of `system-chromium` (default) or `chromium` |
| `acceptance:firefox` | genuine branded Mozilla Firefox through WebDriver BiDi | a build; Firefox at `WILDBLOOM_FIREFOX_PATH`, `/Applications/Firefox.app` (macOS) or `/usr/bin/firefox` (Linux) |
| `acceptance:safari` | installed Safari through Apple's SafariDriver | a build; macOS; `/usr/bin/safaridriver` or `WILDBLOOM_SAFARIDRIVER_PATH` |
| `acceptance:tor` | disposable v3 onion app, Blossom and relay through a real Tor daemon, with `NEWNYM` | a build; `tor` on the usual paths or `WILDBLOOM_TOR_PATH`; Chrome or Chromium |
| `acceptance:tor-browser` | `acceptance:tor --browser system-chromium --branded-tor-browser`: the Chromium journey, then branded Tor Browser ceremonies | as `acceptance:tor` plus a Tor Browser at `WILDBLOOM_TOR_BROWSER_PATH`, `/Applications/Tor Browser.app` (macOS) or `.artifacts/tor-browser/Browser/firefox` (Linux); `--browser` accepts only `system-chromium` |
| `acceptance:maximum` | exact 256 MiB source round trip, plus 256 MiB and one byte refused | a build; Chrome or Chromium |
| `acceptance:cross-device:serve` | coordinator for the two-device LAN ceremony ([`docs/CROSS-DEVICE-ACCEPTANCE.md`](docs/CROSS-DEVICE-ACCEPTANCE.md)) | a build; flags `--public-origin https://<hostname>` (not an IP address) and `--evidence <path>` (required), `--port` (default `8787`) |
| `acceptance:cross-device:verify` | verifies the service record against a `tcpdump` capture and writes a redacted result | flags `--service-evidence`, `--capture`, `--publisher-ip`, `--downloader-ip`, `--coordinator-ip`, `--coordinator-port`, `--recovered-sha256`, `--recovered-size`, `--output`, repeatable `--dns-ip`; see the ceremony document |
| `acceptance:cross-device:self-test` | self-test of the evidence and packet-classification contract | nothing |
| `acceptance:direct` | direct send: `/send` as Android Chrome (Pixel 7 profile, both orientations) and a test receiver acting as Drop in a second Chromium, a real pairing service, a local UDP shim to slow and cut the path, and a real coturn for the relay-only case | `FOREGATHER_SERVER_BIN` and Chrome or Chromium (it builds its own pages); optional `WILDBLOOM_BROWSER_EXECUTABLE`, `COTURN_BIN` (otherwise `turnserver` on `PATH`, else a coturn image already in Docker, `COTURN_DOCKER_IMAGE`; with neither the relay-only case is skipped with a notice; the server caps each allocation at 1,000,000 bytes a second, as KithMoot's does), `DIRECT_REQUIRE_TURN=1` (fail instead of skipping), `DIRECT_ACCEPTANCE_ONLY` (journey name filter), `DIRECT_SCREENS_DIR`; uses foregather-kit 0.6.0 for `flow.exchange()` |
| `acceptance:recovery` | fresh-browser recovery from a restarted real Node replica after the original node stops | a build; `WILDBLOOM_NODE_BIN` (the `wildbloomd` executable); optional `WILDBLOOM_BROWSER_EXECUTABLE`, `WILDBLOOM_NODE_SOURCE_COMMIT`, `WILDBLOOM_RECOVERY_EVIDENCE` (output path) |
| `acceptance:pool` | six real local nodes plus two replacements: erasure-coded and replicated pools, repair and recovery | a build; `WILDBLOOM_NODE_BIN`; optional `WILDBLOOM_BROWSER` (`system-chromium`, `chromium`, `firefox`, `webkit`) and `WILDBLOOM_BROWSER_EXECUTABLE`; flag `--maximum` for 256 MiB; flag `--tor` also needs `WILDBLOOM_TEST_TOR_BIN` |
| `acceptance:pool:quick` | `acceptance:pool --quick`: threshold recovery and repeated automatic owner repair on a small file | a build; `WILDBLOOM_NODE_BIN`; optional `WILDBLOOM_POOL_EVIDENCE` (output path); cannot combine with `--maximum` or `--tor` |
| `acceptance:services` | production UI against a real Node and a checkout fixture for node services | a build; `WILDBLOOM_NODE_BIN` and `WILDBLOOM_CHECKOUT_FIXTURE` (executables); optional `WILDBLOOM_BROWSER_EXECUTABLE` |
| `acceptance:storage-discovery` | production storage-discovery UI against a synthetic relay and intercepted HTTP fixtures | a build; optional `--browser` of `system-chromium` (default), `chromium`, `firefox` or `webkit`; the default needs Google Chrome on macOS and Windows, or Google Chrome or Chromium on Linux |
| `preflight:checkout` | read-only live-checkout check (`GET /checkout/v1/offers`, `OPTIONS /checkout/v1/orders`); never pays | flags `--node`, `--app`, `--offer`, `--rail` (`lightning` or `lnurlcash`), `--max-sats`, `--output` (all required), `--allow-loopback-http`; network access |
| `test:checkout-preflight` | `node --test` suite for the preflight script | nothing |
| `verify:storage-audits` | offline check of saved storage-audit reports against the pinned ciphertext | flags `--blob`, `--sha256`, `--size`, `--origin`, `--output` and two to 64 `--report` paths |
| `test` | `vitest run` | nothing |
| `test:coverage` | `vitest run --coverage` with the coverage thresholds | nothing |
| `test:watch` | `vitest` in watch mode | nothing |
| `typecheck` | `tsc --noEmit` | nothing |
| `encryption:vector` | verifies the FSWNENC1 and legacy WBLMENC1 known-answer vectors | nothing; optional `--emit` or `--emit-multirecord` prints a fixture |
| `encryption:semantic-vectors` | verifies `test-vectors/encryption-semantic.json` against its independent generator | nothing; `--write` regenerates the file |
| `encryption:negative-vector` | regenerates `test-vectors/encryption-negative.json` (writes the file) | nothing |
| `fswnenc2:vector` | regenerates the FSWNENC2 vectors in `test-vectors/` (writes `fswnenc2-per-file.json` and `fswnenc2-vault.json`) | nothing |
| `install:policy` | checks `.npmrc`, the `.nvmrc` Node pin, engines, Wrangler pin, workflow installs and action pins | nothing |
| `secrets` | local secret scanner | nothing |
| `audit` | dependency audit with the single `GHSA-2p57-rm9w-gvfp` exception described above | network access to the npm registry |
| `check` | the ordered list above | Chrome or Chromium for `smoke:browser` and `acceptance:storage-discovery` |
| `ci` | `check` then `audit` | as `check` and `audit` |

## Security rules

- Never accept, generate, log, persist or transmit an `nsec` or raw private key.
  Signing uses either an injected NIP-07 signer after a user action or an exact
  unsigned-event JSON handoff to an external signer. The handoff accepts only
  the returned signed event and must never contact the signer automatically.
- No network action may happen on load. Uploading, relay publication, seeding,
  relay lookup and downloading each require a distinct user action.
- Blossom authorisation events must be short-lived and scoped to the exact
  server hostname and exact blob SHA-256.
- Treat relays, Blossom servers, trackers, peers and signed event content as
  untrusted. Validate sizes, schemes, hashes, signatures and response shapes.
- HTTPS/WSS is mandatory except for explicit localhost development.
- Encrypt content, filename and MIME type by default. Recovery keys stay in
  page memory, never enter network metadata, and must be acknowledged before
  upload. Any envelope-format change requires a version change and vectors.
- Tor-only mode accepts checksum-valid v3 onion endpoints, never falls back to
  clearnet, and must not load, seed or download through WebTorrent.
- Direct WebTorrent must not inherit undeclared public STUN/TURN defaults. Any
  ICE service requires explicit operator configuration, disclosure and tests.
- A file or network-profile change invalidates every prior network consent.
- Joining a torrent swarm reveals network metadata. Keep that warning beside
  the action and require acknowledgement.
- Never render remote strings as HTML. Use `textContent` and safe DOM APIs.
- Keep the core framework-free and inject network primitives in tests.
- Use British English in prose. Use ESM and explicit `.js` extensions for
  relative TypeScript imports.

## Recipient page

- `/get` is its own entry (`get.html`, `src/get/`). It must never include WebTorrent; the build fails if it does.
- It alone gets `'wasm-unsafe-eval'` (response headers and its meta policy). Do not widen the main policy.
- All recipient strings live in `src/get/copy.ts`. The pairing service origin is a build-time constant
  (`VITE_WILDBLOOM_PAIR_RELAY`), never read from a link.

## Sender page and direct send

- `/send` is its own entry (`send.html`, `src/send/`), the phone half of direct send: it sends one file straight to Drop (or another receiver) over a WebRTC data channel, and nothing is stored on any server. It must never include WebTorrent; the build fails if it does.
- Like `/get`, it alone (with `/get`) gets `'wasm-unsafe-eval'`. It also alone gets `screen-wake-lock=(self)` in `Permissions-Policy` (`SEND_PERMISSIONS_POLICY`), so it can keep the phone awake while a file is sent. Every other path, and every other feature, stays denied. Do not widen the global policy.
- All sender strings live in `src/send/copy.ts`, in the recipient page's tone: no technical terms, no promise of how long a send takes or how fast it goes, and the person at the computer is "they". Progress comes from the receiver's acknowledgements, never from bytes queued.
- The pairing service origin is the same build-time constant as `/get`. Pairing links for `/send` use the base `https://<web>/send/` with the trailing slash (namespace `wildbloom.drop`, purpose `send`); `/send/` redirects to `/send` with the fragment kept.
- `src/direct/` implements `wildbloom-direct/1` ("Direct send" in wildbloom-node `docs/PROTOCOL.md`): strict canonical messages over the `foregather-exchange/1` channel (`messages.ts`), data-channel frames (`frames.ts`), the sender and receiver with the protocol's flow control (`transfer.ts`), the peer connection (`peer.ts`) and the two session drivers (`session.ts`). `test-vectors/wildbloom-direct-v1.json` is an unedited copy of that repository's `vectors/wildbloom-direct-v1.json` (branch `docs/direct-send-protocol`, commit fba5bbb); `tests/direct-messages.test.ts` pins its SHA-256. Copy it again rather than editing it.
- ICE servers come only from the authenticated invitation and only if every URL equals an entry of the build-time allowlist (`DIRECT_ICE_ALLOWLIST`, set with `VITE_WILDBLOOM_DIRECT_ICE`, default the owner's coturn). No other server is ever added. The page's TURN credential lives in page memory, is never put in a URL, a log, a message to a server or browser storage, and is dropped when the send ends.
- No `RTCPeerConnection` exists on either end before the receiver accepts. Hiding an address means `iceTransportPolicy: "relay"` with STUN removed; each end decides for itself.
- The file is sealed with a fresh `wbk1_` key per send and streamed from the picked file one 1 MiB record at a time (`createEnvelopeEncoder` in `src/core/crypto.ts`), so memory stays near a constant whatever the size and no browser storage is used. The cap is 250,000,000 bytes.
- A receiver plugs in through the `DirectSink` interface (`src/direct/transfer.ts`): `write` (bytes in order, acknowledged after it resolves), `end` (authenticate, check the manifest, size and SHA-256, keep the file) and `abort`. `createMemorySink` is the browser implementation. Nothing may be savable before `end` resolves.
- The sender's pacing is a function (`Pacing` in `src/direct/transfer.ts`), kept apart from the frame logic. `protocolPacing` is the protocol's window and buffer rules. `src/direct/pacing.ts` adds the relay rate: when the selected candidate pair has a relay candidate at either end (read from `getStats()` once connected and after each ICE restart) the sender sends at most 400,000 envelope bytes a second on average, in bursts of at most 65,536, because a TURN server drops what exceeds its per-allocation rate and SCTP recovers too slowly. A direct pair is not paced. Do not put a time or rate estimate in the page copy.
- The test receiver in `tests/harness/direct-drop/` is built only by `scripts/direct-acceptance.mjs`, with its own Vite config; the production config lists `index.html`, `get.html` and `send.html` only, and `tests/build-boundary.test.ts` checks that.

## Protocol scope

- NIP-07 for browser signer access.
- Canonical Nostr event JSON for manual external signing; this is a custody
  boundary, not a new signer protocol or an anonymity claim.
- NIP-94 kind `1063` for the primary hybrid file event.
- NIP-35 kind `2003` for torrent indexing.
- BUD-01/02/10/11 for Blossom retrieval, upload, references and authorisation.
- BUD-04 (`PUT /mirror`) is how Wildbloom Node replicates an exact encrypted
  blob between nodes. This browser app never calls it; document and test any
  browser use before adding it.
- BUD-03 kind `10063` for explicitly requested trusted server-list discovery.
- Kind `31402` with `forgesworn-storage-service-v1` for opt-in public service
  discovery. Use `402-announce/storage` for signature/schema validation and
  latest-event selection before expiry/availability filtering. Keep signed
  withdrawal watermarks in page memory; never infer a direct upload allowance
  from free mirror shelter or reuse checkout consent after terms change.
- NIP-98 kind `27235` for private exact-URL/method/body checkout and audit requests.
  Never publish these authorisations or payment/audit records to relays.
- The documented `encryption` tag value
  `forgesworn-aes-256-gcm-chunked-v2` is the current shared envelope extension;
  `wildbloom-aes-256-gcm-chunked-v1` remains a historical read extension.

These specifications are drafts. Do not silently invent compatibility claims;
document and test any extension tags before adding them.
