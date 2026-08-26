# Security policy

Wildbloom is a private production candidate. Do not use it for sensitive or
irreplaceable material until the external review and live gates in
`docs/ACCEPTANCE.md` are complete.

## Report a problem

Contact a ForgeSworn repository owner privately. GitHub private vulnerability
reporting is not available for this private repository on the organisation's
current plan. Do not put a working exploit, secret, private key, unpublished
file or personal data in an issue or relay event.

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

The repository being private does not make protocol activity private. Read the
threat model before testing with live infrastructure.
