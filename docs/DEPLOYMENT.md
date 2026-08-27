# Deployment

Wildbloom is a static browser application with an optional minimal Node 24
static server. The server has no account, signer, upload or relay authority.

## Build and serve

```sh
npm ci
npm run ci
npm run release:evidence -- --require-clean --output ../wildbloom-release-evidence.json
npm run serve:production -- --host 127.0.0.1 --port 8080
```

The committed `.npmrc` makes `npm ci` refuse unsupported Node engines and peer
conflicts and prevents dependency `preinstall`, `install` and `postinstall`
hooks. Keep that policy enabled on the build host. Wildbloom's browser build
does not require the native Node hooks present in WebTorrent's dependency tree.
Use the exact Node patch in `.nvmrc` for a canonical release build. The
repository also forces LF text checkouts so Windows cannot publish different
HTML or package-lock bytes merely because of line-ending conversion.

## Hosted marketing site

The marketing material and browser tool are one static build.  For Cloudflare
Pages, prepare the exact Vite output plus the platform's `_headers` rules and a
bounded health response:

```sh
npm run build:cloudflare
wrangler pages deploy dist --project-name wildbloom --branch main
```

`build:cloudflare` first validates the ordinary production build, then adds only
`_headers` and `healthz`.  The header policy is generated from the same
`http-security.mjs` constants as the loopback production server.  Those two
hosting files are deliberately not part of the application release evidence;
the verifier hashes the actual browser assets and checks the live edge headers
and health response separately.

The GitHub Pages workflow is a public hosted preview and fallback.  GitHub Pages
does not apply Cloudflare `_headers`, so it is not the verified production edge
and must not replace the Cloudflare deployment record.

The production server exposes `/healthz`, serves only `index.html` and
eight-character content-hashed JavaScript and CSS assets, rejects source maps
and symbolic links, accepts only `GET` and `HEAD`, applies no-store to HTML,
health and error responses, and applies immutable caching to hashed assets.
It validates the complete build before listening, so `/healthz` cannot report
ready for a missing or malformed build. Unknown or repeated command-line
options fail closed. The Host allowlist accepts hostnames only; ports, paths,
credentials and other URL syntax are configuration errors.

At startup the server loads the validated release into one immutable process
snapshot. It accepts at most 64 files, 32 MiB per file and 64 MiB in total,
then serves those exact bytes without reopening `dist` for each request. A file
changed, removed or added on disk after readiness cannot alter what that
process serves. Deploy by starting a new process against the new complete
release and switching traffic only after its `/healthz` succeeds; changing the
directory underneath a running process is not a release mechanism.

Every request target containing a query string is rejected, including requests
for hashed assets and `/healthz`. `GET` and `HEAD` requests carrying a framed
body are also rejected and their connection is closed. The server logs only
its listening address: it does not log or reflect request targets, headers or
bodies. This keeps accidental recovery keys and other private input out of the
origin process output, but it cannot stop an upstream proxy from observing or
logging a request before rejection.

The origin uses Node's strict HTTP parser with a 16 KiB request-header limit,
ten-second header and request deadlines, and a one-second deadline-check
interval. Conflicting request framing, invalid header bytes and oversized
headers receive the same bounded, no-store, security-header response before
the connection closes. These limits are defence in depth behind the reverse
proxy, not a substitute for edge request limits and connection controls.

The release-evidence JSON contains no secret material. It records the full
source commit, whether the source tree was clean, the exact Node and npm build
versions, the package-lock hash, an aggregate build hash and the byte length
and SHA-256 of every serveable file.
The command refuses to overwrite an existing record or to write into `dist`.
Store it outside the repository with the release record rather than publishing
it from the web root.

Hosted CI generates that evidence independently on Windows, Linux and macOS,
retains the three small metadata records for seven days, validates their exact
shape and source commit, then requires identical toolchains and production
bytes. A platform-specific bundle cannot silently become the canonical release.
The comparison job does not upload or retain the application bundle itself.

## Verify the deployed origin

After the release is live, verify it from a logged-out network location:

```sh
npm run verify:deployment -- \
  --origin https://wildbloom.example \
  --evidence ../wildbloom-release-evidence.json \
  --output ../wildbloom-deployment-verification.json
```

Run the verifier from the `sourceCommit` recorded in that evidence so its
expected HTTP policy is the policy shipped with the release.

The verifier has no default target and performs no request until both an origin
and release-evidence file are supplied. It accepts HTTPS clearnet origins and
checksum-valid HTTP v3 onion origins, refuses credentials, redirects and URL
paths, streams every response within the attested byte count, and checks exact
hashes, MIME types, cache policy, health bytes and security headers. HTTPS must
also provide at least one year of HSTS on every checked response. Verification
is capped at 32 MiB per file and 64 MiB for the complete web build. Run onion
verification through an operator-controlled Tor environment such as `torsocks`;
the verifier validates the onion authority but does not silently configure a
proxy.

`--allow-loopback` exists only for controlled local acceptance. A timestamped
verification record contains no secret material, cannot overwrite an existing
file and cannot be written into `dist`.

It binds to loopback by default and validates the HTTP Host header. Set an
explicit comma-separated allowlist when a reverse proxy preserves the public
host:

```sh
WILDBLOOM_ALLOWED_HOSTS=wildbloom.example,exampleexampleexampleexampleexampleexampleexampleabcd.onion \
  npm run serve:production -- --host 127.0.0.1 --port 8080
```

The example onion hostname above is illustrative, not a valid service.

## Clearnet edge

The TLS reverse proxy must:

- redirect HTTP to HTTPS;
- set HSTS after the domain and certificate path are proven;
- preserve the repository CSP, Permissions-Policy, Referrer-Policy,
  Cross-Origin-Opener-Policy, Cross-Origin-Resource-Policy,
  X-Content-Type-Options and frame denial;
- reject request bodies and query strings without reflecting them, and disable
  request-target, header and body logging;
- minimise IP and user-agent retention;
- expose `/healthz` without weakening the application headers;
- provide atomic release switching and a tested rollback.

The CSP is fail-closed for resource types Wildbloom does not use and permits
arbitrary HTTPS/WSS connections because users select their own Nostr, Blossom
and tracker endpoints. Runtime validation still restricts schemes,
credentials, endpoint counts, onion addresses and redirects. Do not replace
the exact CSP or Permissions-Policy with a hosting provider's broader defaults;
deployment verification treats any policy drift as a failure.

Do not rely on the origin server's no-request-logging policy to sanitise proxy,
load-balancer, CDN or platform logs. Confirm the complete request path and its
retention settings with a private marker that never contains a real key.

Wildbloom configures WebTorrent with no public ICE servers. Do not add STUN or
TURN defaults at the hosting edge or by patching the bundle. An operator ICE
service needs an explicit endpoint/credential design, user-facing disclosure,
retention policy and cross-network packet-level acceptance first.

## Onion service

Run the static server on loopback and point a v3 onion service at it. A minimal
Tor configuration resembles:

```text
HiddenServiceDir /var/lib/tor/wildbloom/
HiddenServicePort 80 127.0.0.1:8080
```

Protect the onion-service private key and back it up according to the operator
threat model. Onion-service traffic is already end-to-end encrypted, so HTTP
inside the onion service is acceptable according to Tor Project guidance.

Do not expose a WebTorrent tracker or proxy torrent peer traffic through Tor.
Tor-only mode deliberately omits both.

## Rollout evidence

A real deployment is complete only when the exact source commit, built asset
hashes, public or onion address, health response, response headers, process
identity, bind address, rollback target and logged-out reachability have been
recorded. `verify:deployment` records the byte and edge-header portion; process
  identity, bind address, snapshot start, rollback and log policy remain
  operator evidence. A
GitHub Actions build is not live deployment proof.
