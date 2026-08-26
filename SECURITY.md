# Security policy

Wildbloom is an early private prototype. Do not use it for sensitive or
irreplaceable material.

## Report a problem

Use GitHub's private vulnerability reporting for this repository. Do not put a
working exploit, secret, private key, unpublished file or personal data in a
public issue or relay event.

## Non-negotiable boundaries

- Wildbloom never needs an `nsec`, seed phrase or raw signing key.
- Signing occurs through NIP-07 after a deliberate user action.
- No network action is automatic.
- Downloaded bytes are withheld until signed size and SHA-256 checks pass.
- Torrent metadata is checked against the signed event before bytes are used.
- HTTPS/WSS is required away from localhost.

The repository being private does not make protocol activity private. Read the
threat model before testing with live infrastructure.
