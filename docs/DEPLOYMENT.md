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

The production server exposes `/healthz`, serves only `index.html` and
eight-character content-hashed JavaScript and CSS assets, rejects source maps
and symbolic links, accepts only `GET` and `HEAD`, applies no-store to HTML,
health and error responses, and applies immutable caching to hashed assets.
It validates the complete build before listening, so `/healthz` cannot report
ready for a missing or malformed build.

The release-evidence JSON contains no secret material. It records the full
source commit, whether the source tree was clean, the package-lock hash, an
aggregate build hash and the byte length and SHA-256 of every serveable file.
The command refuses to overwrite an existing record or to write into `dist`.
Store it outside the repository with the release record rather than publishing
it from the web root.

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
- avoid request bodies and query strings in logs;
- minimise IP and user-agent retention;
- expose `/healthz` without weakening the application headers;
- provide atomic release switching and a tested rollback.

The CSP permits arbitrary HTTPS/WSS because users select their own Nostr,
Blossom and tracker endpoints. Runtime validation still restricts schemes,
credentials, endpoint counts, onion addresses and redirects.

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
recorded. A GitHub Actions build is not live deployment proof.
