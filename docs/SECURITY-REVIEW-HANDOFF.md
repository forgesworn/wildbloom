# Independent review handoff

Prepared 6 October 2026. Status: scope prepared; reviewer, funding, dates and
independent findings/retest are not yet established. This document is not an
audit report. Track commissioning in [issue 28](https://github.com/forgesworn/wildbloom/issues/28).

## Ready for quotation

Use [the brief](SECURITY-REVIEW-BRIEF.md) for the seven work packages and the two
exact shipped source baselines. Ask for separate effort estimates for browser
cryptography/protocols, storage pools/owner repair, native filesystem/IPC and
release trust. Allow a remediation and independent retest period in the quote.
No production access, private signing key or real user receipt is required.

The reviewer must disclose prior implementation work and conflicts, retain the
right to disagree with product claims, produce reproducible findings and permit
a public final report after coordinated remediation. Maintainer testing and an
AI-assisted review cannot close the independent-review gate.

Before commissioning, record:

| Decision | Required record | Current state |
| --- | --- | --- |
| Reviewer | Named lead, relevant experience, conflict statement | Unassigned |
| Funding | Approved budget or confirmed funded review route | Unassigned |
| Scope | Both commit hashes, exclusions, dependency boundaries | Shipped baseline in brief; freeze with reviewer |
| Timing | Start, report and remediation/retest dates | Unassigned |
| Disclosure | Private reporting channel, disclosure window, public report rights | Agree before work |
| Retest | Exact remediation commits and independent outcome | Not started |

## Routes checked on 6 October 2026

| Route | Published service | Next decision |
| --- | --- | --- |
| [OTF Security Lab](https://www.opentech.fund/labs/security-lab/) | Funded security audits for internet-freedom projects | Establish mission fit and eligibility; funding is not assumed |
| [OSTIF](https://ostif.org/get-an-audit/) | Scope development, independent reviewer sourcing and possible funding/sponsor assistance | Submit the bounded scope once owner authorises contact |
| [Least Authority](https://leastauthority.com/security-consulting/) | Commercial review of cryptographic protocols and distributed systems | Request a scoped quote including native/browser expertise and retest |

These are candidates, not endorsements or booked engagements. My assessment is
that a funded route is worth exploring before approving commercial expenditure;
none has confirmed eligibility, availability or a Wildbloom price. The existing
issue also lists other commercial candidates for comparison.

## Reproducible source and tests

Clone the public `forgesworn/wildbloom` and `forgesworn/wildbloom-node`
repositories and detach at the full commits in the brief. Keep the Node tree
beside the browser tree. Use the locked dependencies and pinned toolchains.

```sh
# Node checkout
cargo test --locked --workspace
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo build --locked -p wildbloomd
npm ci --ignore-scripts --prefix desktop
npm test --prefix desktop
npm run test:native --prefix desktop

# Browser checkout; adjust the sibling Node binary path on Windows
npm ci --ignore-scripts
npm run ci
WILDBLOOM_NODE_BIN=../wildbloom-node/target/debug/wildbloomd npm run acceptance:pool:quick
WILDBLOOM_NODE_BIN=../wildbloom-node/target/debug/wildbloomd npm run acceptance:recovery
```

Native Linux needs the desktop development packages, Xvfb and session D-Bus in
Node CI. Physical browsers, external signers and retail installers have their
own checklists; hosted tests do not reproduce those environments. Reviewers
should create independent malicious-input and fault-injection tests rather than
only rerun the maintainer suite. Later permission-hardening revisions add the
Windows second-account test; include their exact commit in the agreed scope.

The preview release includes `SHA256SUMS` and `build-provenance.json`; production
deployment workflow evidence records source, exact build bytes and headers.
Record the retrieval date and digest of every artifact used. Do not substitute
the moving `main` branch or an unrecorded installer for the agreed baseline.

## Quote request draft

> We would like an independent review of Wildbloom's encrypted browser file
> delivery and Wildbloom Node's erasure-coded storage pools, owner-side repair,
> desktop controls and release trust. Please quote the seven work packages in
> the linked brief, identify the reviewer and conflicts, propose dates and
> exclusions, and include remediation retest and a public final report. Testing
> uses synthetic data and controlled services; production probing needs a
> separately agreed read-only scope. We can supply exact public source and
> build/acceptance evidence without credentials or customer material.

This is a draft for the owner. It has not been sent and no engagement or spend
has been authorised. Candidate procurement routes are listed in issue 28.

## Closure record

For each finding retain severity, affected commit/code, exploit conditions,
reproduction, fix commit and independent retest. Critical/high findings must be
fixed and retested; other findings require fixes or explicit residual-risk
decisions. Link the public report and the exact reviewed/remediated lineage from
the readiness ledger. Until then the gate remains open.
