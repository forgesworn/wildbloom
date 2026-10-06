# Production readiness work ledger

This is the delivery checklist for the 5 September 2026 request to finish
Wildbloom and its associated libraries. A local check, merged source, published
package, deployed service and physical acceptance are separate evidence.
Wildbloom remains a production candidate until the release gates below pass.

## Software and integration

| Work | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Link reconnect after prolonged relay loss | [PR 38](https://github.com/forgesworn/forgesworn-link/pull/38) merged: exact peer transfer after a 61-second relay outage. [PR 40](https://github.com/forgesworn/forgesworn-link/pull/40), source `d9998ac`, aligns its optional adapter with Shelter Kit v0.4.1; all three platform checks passed | Physical Android relay-restart row in issue 37 and the network matrix below |
| Bothy shared-core integration | [PR 11](https://github.com/forgesworn/bothy-node/pull/11) consumes Shelter Kit v0.4.1 and Link `d9998ac`. All 535 local tests, formatting, Clippy and docs passed; [Rust CI](https://github.com/forgesworn/bothy-node/actions/runs/33937764573) and [Android CI](https://github.com/forgesworn/bothy-node/actions/runs/33937764531) passed; merged source is `a160cb0` | Physical phone acceptance; the existing review checkout and staged phone APK were preserved |
| Node shared core | [PR 19](https://github.com/forgesworn/wildbloom-node/pull/19), source `cbbfdcd`, delivers Node 0.2.2 with Shelter Kit v0.4.1. All seven platform checks passed. Live two-process Tor replication, deliberate loss, exact repair, source shutdown and onion-identity restart passed in 48.98 seconds | Independent physical-node recovery and trusted release acceptance |
| Node preview delivery | [Node 0.3.2 preview.1](https://github.com/forgesworn/wildbloom-node/releases/tag/v0.3.2-preview.1) provides six installers with SHA-256 checksums and source/build provenance. [Installer matrix 37444555366](https://github.com/forgesworn/wildbloom-node/actions/runs/37444555366) records all four targets, installed-package acceptance on Linux and Windows CI runners, and bundled pool commands on both Mac architectures | These previews do not have trusted Windows signing or Mac Developer ID/notarisation. Clean retail-machine and multi-device acceptance remain open |
| Owner repair failures | [Node PR 38](https://github.com/forgesworn/wildbloom-node/pull/38), source `f345a1d`, stops on local scratch write errors and adds corruption, threshold, rejected-upload, false-acknowledgement, hard-kill and expiry tests. All 62 local daemon tests and ten native Mac lifecycle checks passed; [CI](https://github.com/forgesworn/wildbloom-node/actions/runs/37276808241) runs the cross-platform suite, including Linux ENOSPC. Browser recovery workflows now pin the 0.3.2 installer source `13dc0c8` | A hard kill still requires review of leftover temporary files. Fault injection and one-host processes do not establish physical independence or trusted installer acceptance |
| Interrupted repair cleanup | [Node PR 40](https://github.com/forgesworn/wildbloom-node/pull/40) adds explicit desktop review and cleanup, with the daemon-compatible lock, changed-review refusal and preservation of receipts/reports. All 17 desktop Rust tests and 13 native macOS lifecycle checks passed locally. Hosted native lifecycle checks exercise Linux, macOS and Windows; exact source and outcomes are retained with the release evidence | Cleanup needs explicit confirmation and leaves repair stopped. Physical-device and trusted-installer acceptance remain separate |
| Desktop pool controls | [Node PR 36](https://github.com/forgesworn/wildbloom-node/pull/36) adds local signed-receipt import, read-only per-part checks and explicitly authorised owner repair. Local validation passed 52 daemon tests, 11 native desktop tests, browser/native pool recovery and desktop UI consent/reflow/accessibility checks. The 0.3.2 preview and its exact build evidence are listed in the [release](https://github.com/forgesworn/wildbloom-node/releases/tag/v0.3.2-preview.1) | Only one Mac is available. The [multi-device pool checklist](https://github.com/forgesworn/wildbloom-node/blob/main/docs/PHYSICAL-POOL-ACCEPTANCE.md) is prepared, not performed. Trusted signing, independent review and physical acceptance remain separate |
| Envelope review follow-ups | Nine authenticated semantic vectors pass in all three implementations. The browser derives its 257-record bound; Rust rejects authenticated oversized lengths before arithmetic. [PR 37](https://github.com/forgesworn/wildbloom/pull/37), source `0be8563`, fixes emoji truncation. Browser source has 156 tests, native Safari and maximum-file acceptance; [PR 38](https://github.com/forgesworn/wildbloom/pull/38) adds two controlled-server cleanup regressions and bounded Tor diagnostics | Independent review and the physical browser gates below |
| Browser release evidence | Build SHA-256 `1ee3521ad0df9dd62dbe32acf5af8c99b79d65fca475bc2f22b673480ea56f06` is equal across all three operating systems. All eight [CI jobs](https://github.com/forgesworn/wildbloom/actions/runs/33937896778), [Tor](https://github.com/forgesworn/wildbloom/actions/runs/33937918715) and [branded Tor Browser](https://github.com/forgesworn/wildbloom/actions/runs/33937920198) passed on `745f3cc`. Source `97792e5` was [deployed and verified](https://github.com/forgesworn/wildbloom/actions/runs/33938335498) at 02:11 UTC on 5 September; [monitor 33938445278](https://github.com/forgesworn/wildbloom/actions/runs/33938445278) passed. Exact deployment source, response headers and byte verification are retained in [production deployment records](https://github.com/forgesworn/wildbloom/actions/workflows/cloudflare-production.yml); [monitor runs](https://github.com/forgesworn/wildbloom/actions/workflows/production-monitor.yml) check the configured deployed commit | Hosted source and exact-byte evidence are retained by the production deployment workflow; physical and independent acceptance remain separate |
| Shelter Kit contract completion | [v0.4.1](https://github.com/forgesworn/shelter-kit/releases/tag/v0.4.1), source `4bd5da2`, provides verification timestamps, scoped listing, shell tombstones and optional admission filters. It also prevents concurrent policy updates from restoring a revoked owner. All 83 tests, format, Clippy and audit pass. The verified crate archive is a GitHub prerelease | Shell/product acceptance and independent review. Schema-5 data must not be downgraded to a core that predates tombstone enforcement |
| Shared envelope consumers | [TypeScript 0.6.1](https://github.com/forgesworn/stash/releases/tag/v0.6.1), source `706061f`, and [Rust 0.6.1](https://github.com/forgesworn/stash-rs/releases/tag/v0.6.1), source `b05ccb7`, have verified GitHub archives and clean dependency audits. Shared exact-byte Unicode vectors cover NFC and the emoji boundary; older non-NFC Rust frames remain readable. TypeScript's installed archive also passed both vectors | Application consumption and real external-signer recovery. npm/crates.io publication is separate; npm authentication was unavailable in this session |
| Application recovery after source loss | [Recovery journey](APPLICATION-RECOVERY.md): explicit replica selection preserves signed size/hash and encryption checks. Automated acceptance uses two real loopback Node stores, an external-signing fixture, a fresh signer-free browser, original-node loss, replica restart and wrong-key/corrupt-copy refusal | Physical application recovery, real signer custody, desired-replica policy, discovery and ongoing repair evidence for any durability claim |
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
