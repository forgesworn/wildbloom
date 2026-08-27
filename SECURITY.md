# Security policy

Wildbloom is a public, unreleased production candidate. Do not use it for
sensitive or irreplaceable material until the external review and live gates in
`docs/ACCEPTANCE.md` are complete.

## Report a problem

Use [GitHub private vulnerability
reporting](https://github.com/forgesworn/wildbloom/security/advisories/new). Do
not put a working exploit, secret, private key, unpublished file or personal
data in a public issue or relay event.  Non-sensitive usage questions belong in
[`SUPPORT.md`](SUPPORT.md).

## Non-negotiable boundaries

- Wildbloom never needs an `nsec`, seed phrase or raw signing key.
- Signing occurs through NIP-07 after a deliberate user action.
- No network action is automatic.
- Local encryption is the default; recovery keys never enter network metadata
  or browser storage.
- Downloaded bytes are withheld until signed size and SHA-256 checks pass.
- Torrent metadata is checked against the signed event before bytes are used.
- HTTPS/WSS is required away from localhost.
- Tor-only mode accepts exact v3 onion endpoints and disables WebTorrent.
- The bundled origin bounds request parsing and returns generic, no-store,
  security-header responses for malformed framing without logging request
  targets, headers or bodies. Upstream infrastructure needs the same explicit
  log and request-limit policy.
- The origin validates and pins the complete bounded release in memory before
  readiness, then performs no per-request release-file reads. A deployment
  change requires a new process and health-checked traffic switch.

The repository is public, and protocol activity is public or observable at the
boundaries described in the threat model.  Read it before testing with live
infrastructure.

## Supply-chain boundary

Production and CI use Node 24.x. Dependabot groups routine minor and patch
updates, while the Node runtime and `@types/node` major move together only after
the complete Windows, Linux and macOS matrix has been deliberately retargeted.
GitHub Actions is restricted at repository level to GitHub-owned actions pinned
to full commit SHAs.  Cloudflare deployment uses the exact locked Wrangler CLI
rather than broadening that action policy.
