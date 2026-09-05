# Production readiness work ledger

This is the delivery checklist for the 5 September 2026 request to finish
Wildbloom and its associated libraries. A local check, merged source, published
package, deployed service and physical acceptance are separate evidence.
Wildbloom remains a production candidate until the release gates below pass.

## Software and integration

| Work | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Link reconnect after prolonged relay loss | [PR 38](https://github.com/forgesworn/forgesworn-link/pull/38) merged at `e066e41`: exact peer transfer after a 61-second relay outage; all three platform checks passed. [PR 39](https://github.com/forgesworn/forgesworn-link/pull/39) merged at `83172f9` and aligns its optional adapter with Shelter Kit v0.4.0 | Bothy consumer delivery and the physical Android relay-restart row in issue 37 |
| Node shared core | [PR 18](https://github.com/forgesworn/wildbloom-node/pull/18) merged at `5832173`: Node 0.2.2 consumes Shelter Kit v0.4.0 with one TLS provider. Platform CI [33935641537](https://github.com/forgesworn/wildbloom-node/actions/runs/33935641537) passed; live Tor replication, deliberate loss, exact repair, source shutdown and onion-identity restart passed in 38.98 seconds | Current 0.2.2 installer matrix [33936054043](https://github.com/forgesworn/wildbloom-node/actions/runs/33936054043), trusted signing and physical clean-machine acceptance |
| Envelope review follow-ups | Nine authenticated semantic vectors pass in all three implementations. The browser derives its 257-record bound; Rust rejects authenticated oversized lengths before arithmetic. Browser [PR 35](https://github.com/forgesworn/wildbloom/pull/35) and Tor archive pin [PR 36](https://github.com/forgesworn/wildbloom/pull/36) are merged. Source `324ab77` was deployed with exact-byte verification and a green production monitor | Deliver the Unicode filename correction in [PR 37](https://github.com/forgesworn/wildbloom/pull/37), with current acceptance and exact deployment; independent review remains open |
| Shelter Kit contract completion | [v0.4.0](https://github.com/forgesworn/shelter-kit/releases/tag/v0.4.0), source `cdd2181`, provides verification timestamps, scoped listing, shell tombstones and optional admission filters. All 82 tests, format, Clippy and audit pass across the platform matrix. The verified crate archive is a GitHub prerelease | Shell/product acceptance and independent review. Schema-5 data must not be downgraded to a core that predates tombstone enforcement |
| Shared envelope consumers | [TypeScript 0.6.0](https://github.com/forgesworn/stash/releases/tag/v0.6.0) and [Rust 0.6.0](https://github.com/forgesworn/stash-rs/releases/tag/v0.6.0) have verified GitHub package archives and clean audits. Shared Unicode vectors reproduce the Rust NFC gap and TypeScript/browser emoji truncation; the 0.6.1 fixes preserve older Rust reads | Complete 0.6.1 delivery and application consumption. npm/crates.io publication is separate; npm authentication was unavailable in this session |
| Node durability and product integration | Existing two-node repair/source-loss tooling; no implied replica-count promise | Independent application recovery after source loss, desired-replica policy, discovery and repair evidence for any durability claim |
| Link deployment and network acceptance | Real-network records cover a subset of macOS/Linux paths; founders' relay deployment PR 26 is draft. Current relay source logs addresses only at debug; the proposed unit uses info. On 5 September the repository had no deployment secret and SSH to the configured host timed out | Reachable authorised deployment route, verified limits/retention and relay acceptance; missing phone/NAT/Windows/VPN rows and sustained load/abuse acceptance |

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
