# Production readiness work ledger

This is the delivery checklist for the 5 September 2026 request to finish
Wildbloom and its associated libraries. A local check, merged source, published
package, deployed service and physical acceptance are separate evidence.
Wildbloom remains a production candidate until the release gates below pass.

## Software and integration

| Work | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Link reconnect after prolonged relay loss | [PR 38](https://github.com/forgesworn/forgesworn-link/pull/38): regression reproduced the permanent failure after 61 seconds; patched endpoints reconnect and transfer exact peer bytes after the production timeout; workspace tests and Clippy pass locally | Platform CI, merge, consumer pins and the physical Android relay-restart row in issue 37 |
| Node shared core | Local branch `chore/shared-core-upgrade` consumes Shelter Kit v0.2.2, preserves local grant provenance and selects one TLS provider | Node/desktop platform checks, real Tor replication/repair/restart, merge and packaged acceptance |
| Envelope review follow-ups | Authenticated bad-metadata and wrong-padding vectors for all three readers; derived 257-record decode bound; current FSWNENC2 documentation; local full CI passes | Platform/browser matrix, current maximum-file/Tor/Safari gates and exact deployment |
| Shelter Kit contract completion | Runtime owner/grant/quota APIs, advisory class metadata and lane-aware repair exist in v0.2.2 | Verification timestamps, shell policy tombstones, owner-scoped listing, admission filters and their migration/adversarial tests; versioned consumer integration |
| Shared envelope consumers | Wildbloom, Stash and stash-rs write FSWNENC2 and retain older readers | Verify the new semantic vectors across both Stash implementations, resolve any differences and verify package/consumer release paths |
| Node durability and product integration | Existing two-node repair/source-loss tooling; no implied replica-count promise | Independent application recovery after source loss, desired-replica policy, discovery and repair evidence for any durability claim |
| Link deployment and network acceptance | Real-network records cover a subset of macOS/Linux paths; founders' relay deployment PR 26 is draft | Review/deploy relay with verified limits and retention; missing phone/NAT/Windows/VPN rows and sustained load/abuse acceptance |

## Recovery words

`nsec-tree@1.6.0-alpha.1` and `@forgesworn/shamir-words@1.2.0-alpha.1` are
published on npm's `alpha` tag; stable `latest` remains unchanged. Local
typechecks and 180/69 tests passed during the readiness audit. The typed
recovery kind and public fingerprint distinguish exact-key, tree-nsec and
mnemonic derivation; typed Shamir reconstruction rejects mixed split sets.

The [Heartwood physical matrix](https://github.com/forgesworn/heartwood-esp32/blob/main/docs/recovery-words-v1-test-matrix.md)
still needs every P0-P9 row, using an explicitly designated disposable signer:
paper backup, reset, 19/31-word restoration, exact public identity, passphrase,
legacy and corruption cases. Add the paper-share reconstruction ceremony and
retain only public identities, build identifiers and outcomes. No recovery
words or other secrets belong in evidence. Stable promotion depends on that
acceptance. Wildbloom file recovery still uses a separate `wbk1_` per-file key;
identity recovery words do not reconstruct a lost file key.

## Human, physical and external release gates

| Gate | Required evidence |
| --- | --- |
| Independent security review | Reviewer independent of design/implementation, agreed funded scope, report, remediation and independent retest per `SECURITY-REVIEW-BRIEF.md`; issue 28 remains open |
| Two physical browser devices | Complete `CROSS-DEVICE-ACCEPTANCE.md` and obtain a reviewed, redacted passing record; zero Blossom blob bytes, exact peer recovery and teardown; issue 26 |
| Human browser/signing review | Tor Browser chrome/security-level/new-identity/cancellation journey and intended external signer/transfer medium |
| Accessibility | VoiceOver/Safari, NVDA, actual zoom/forced-colours and independent keyboard review per `ACCESSIBILITY.md` |
| Resource and lifecycle limits | Current maximum-file gate plus real operating-system pressure, low-end device and operating-system loss tests |
| Provider operations | Zone-specific log-retention evidence, onion custody, operator privacy notice and name clearance; deployment monitor and rollback evidence are already recorded in issue 7 |
| Trusted desktop release | Signing authorities, valid platform signatures/notarisation, installer hashes, clean-machine install/reboot/update/uninstall and onion retention on every advertised target; Node issue 8 |

Do not mark a physical or independent-review row complete from source changes,
emulators, a test harness, CI or a successful build. Record the exact source and
artefact used by each acceptance run before promoting the corresponding claim.
