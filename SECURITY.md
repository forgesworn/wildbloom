# Security policy

Wildbloom is an early private prototype. Do not use it for sensitive or
irreplaceable material.

## Report a problem

Contact a ForgeSworn repository owner privately. GitHub private vulnerability
reporting is not available for this private repository on the organisation's
current plan. Do not put a working exploit, secret, private key, unpublished
file or personal data in an issue or relay event.

## Non-negotiable boundaries

- Wildbloom never needs an `nsec`, seed phrase or raw signing key.
- Signing occurs through NIP-07 after a deliberate user action.
- No network action is automatic.
- Downloaded bytes are withheld until signed size and SHA-256 checks pass.
- Torrent metadata is checked against the signed event before bytes are used.
- HTTPS/WSS is required away from localhost.

The repository being private does not make protocol activity private. Read the
threat model before testing with live infrastructure.
