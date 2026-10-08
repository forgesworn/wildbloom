# Live paid-storage acceptance

This checklist separates controlled integration tests from live acceptance.
A one-Mac LNURLcash run on 7 October 2026 activated a paid allowance, survived
a daemon restart and recovered all 39,936 original bytes from encrypted storage.
A fresh full-read audit subsequently passed with one target verified and zero
failures, with its digest independently recomputed over all 65,608 ciphertext
bytes. Only Bark 1.3.13 was enabled for that passing run. The earlier connection
failures remain part of the private evidence; the passing result does not
establish that the separately patched unpacked extension works with this pairing.
On 8 October, the paired restore also passed authenticated order recovery and a
fresh full-read audit using the existing Heartwood pairing and user-reported
Bark 1.3.14. The restored file matched all 39,936 original bytes. This completes
the one-Mac paired-restore check, not the full live acceptance ceremony or hosted
operator acceptance. Sensitive evidence is retained privately.

This ceremony checks one actual operator and receiving service,
one payment rail at a time. A Lightning pass does not establish LNURLcash
acceptance. Physical pool recovery is a separate test.

## Required inputs

- An operator-controlled node URL with checkout and storage proofs enabled,
  exact browser-origin CORS, and a reviewed TLS proxy configuration.
- The operator's real receiving service: Phoenixd with its limited-access
  password, or a configured LNURLcash issuer with pinned endpoints and key.
  Provision credentials privately on the operator machine, never in this repo,
  chat, command arguments, browser storage or test reports.
- A low-cost, short-term test offer and an agreed maximum spend in sats. Include
  wallet routing fees in the separately approved total budget. The preflight
  ceiling checks the advertised storage price only; it does not authorise a
  purchase or enforce a future invoice/fee limit.
- A dedicated test signer via NIP-07 or the existing external-signing handoff,
  a wallet controlled by the tester and a disposable non-sensitive source file.
- An operator who can stop/restart the **designated test node**, find an original
  invoice, retain consistent checkout/storage backups and resolve a refund.
  Test the operator's refund and backup/restore procedures before public sales.

Record exact browser/daemon/installer source versions and the receiving
service version. Keep operational details and evidence in a private directory.
Do not use the public synthetic harness signer for a funded live identity.

## Read-only preflight

Run from this checkout with its supported Node version. Substitute the chosen
operator, offer, browser origin and test ceiling:

```sh
npm run preflight:checkout -- \
  --node https://storage.example \
  --app https://wildbloom.forgesworn.dev \
  --offer small-test --rail lightning --max-sats 10 \
  --output /absolute/private/path/checkout-preflight.json
```

This makes only `GET /checkout/v1/offers` and
`OPTIONS /checkout/v1/orders`. It creates no order, invoice or payment and
contacts no wallet, issuer or relay. The chosen node sees the tester's address,
browser origin and request timing. Normal system DNS/TLS routing applies;
this is a direct-mode operator tool, not the daemon's pinned receiving transport.
An explicit `--allow-loopback-http` exception accepts only numeric loopback HTTP
addresses for local testing. Onion checkout is refused.

The check requires HTTPS, exact node-origin binding, JSON with `no-store`, the
chosen available rail, one matching offer within the price ceiling and exact
browser-origin CORS for authorisation and JSON POSTs. Responses have a ten-second
deadline and 64 KiB body cap; redirects are refused. It checks deployment
readiness, not every contract field or issuer signature. The browser and daemon
still validate the actual quote and payment independently.

A successful record is **`preflight-passed`**, with
`livePaymentAccepted: false`. It contains hashes of origins, selected offer and
response, price, capacity and time; no raw origin, policies, invoice, keys or
assets. Hashes can still correlate known origins. Keep it private. Output is
created exclusively (never overwritten), with Unix mode 0600; on Windows use a
private directory with appropriate ACLs. Failed checks produce no passing record.

## One live purchase and restart recovery

1. Open the exact deployed browser version, explicitly choose direct mode and
   select the approved node. Load its offers. Review capacity, expiry, grace,
   price, delivery and refund terms. Delivery is operator-managed, not metered.
2. Request one private quote. Verify the chosen rail and offer. Save its order
   reference privately **before** requesting a payment. Check that the actual
   quote remains within the agreed test spend; the preflight is a snapshot.
3. Request one invoice, or submit one exact-value note from the configured
   issuer. For Lightning, independently check amount/network/expiry and wallet
   fees, then pay once. Never paste a note or invoice into a report or chat.
4. Explicitly check the **same** order until its observed state is `active`.
   Record settlement in the operator's receiving service independently. A wallet
   saying paid is not sufficient to prove allowance activation. If uncertain,
   retain the original reference and reconcile it; do not pay again or create a
   replacement invoice. `refund_required` needs the operator's direct resolution.
5. Stop and restart the designated test daemon using the same private stores.
   Reload the browser, reconnect the original signer, recover the saved order
   reference and check it. Require the same quote digest, allowance ID and
   deadlines, and only one settlement in the receiving service.
6. Upload the small file encrypted using the activated allowance. Save the
   recovery material separately. No file event needs to be published publicly
   for this test. Record source/ciphertext sizes and hashes privately.
7. In a fresh browser session, recover the encrypted file with the saved
   recovery material. Compare recovered bytes and SHA-256 with the original.
   Run a fresh full storage audit and save its private result. A successful audit
   proves retrieval at that moment, not continuous or independent custody.
   The audit displays when HTTP-auth approval (kind 27235) is pending. Failed
   targets include a safe stage and reason on screen and in the private report's
   `failures` array; `failed` retains the origin list for existing consumers.
   Signer rejection or expiry is not evidence of lost storage. Reconnect/approve
   and retry that audit before considering repair. HTTP, invalid challenge,
   independent retrieval and digest failures remain distinct. Do not publish
   the report or add a new payment to resolve an audit failure.
8. Stop the test node cleanly. Make a consistent offline backup of its paired
   checkout and storage directories, including SQLite WAL where present. Retain
   the original backup unchanged. Restore copies into an isolated operator test
   environment using the documented matching configuration, with the original
   node stopped. Never run two copies of a spendable-note ledger concurrently.
   Repeat original-order recovery and file/audit verification. Never replace a
   live store to simulate a failure. Treat this row as blocked if a safe isolated
   restore environment is unavailable.
9. Record fulfilment/refund resolution and the test-data retention decision.
   Stop test services. Do not delete wallets, pending journals or private order
   references as generic test cleanup.

For LNURLcash, repeat with a fresh test purchase and an exact-value note. Verify
the operator's replacement certificate/settlement through its private tools;
never export the replacement spend or secret. An uncertain rotation must be
reconciled using its saved journal. Do not re-submit another note to resolve it.

## Evidence and remaining physical gate

### One-Mac observations, 7 October 2026

These observations concern a loopback development daemon built from Node source
`ce4bceaea65b3a2992933ecaa38aa7545a79e044`, a real Moneyer LNURLcash purchase and
the existing external signer. They do not establish hosted operator readiness,
Phoenixd acceptance or independent physical storage.

| Check | Observed result |
| --- | --- |
| Paid allowance and daemon restart | Passed: the original order and receipt survived restart; one order and settlement were retained. |
| Fresh-browser encrypted recovery | Passed: all 39,936 plaintext bytes matched the source. |
| Fresh full-read audit before backup | Passed: 1/1 targets, zero failures; a fresh nonce and independently recomputed digest over 65,608 ciphertext bytes. |
| Offline backup after upload | Passed: both stores were copied with the daemon stopped; SQLite integrity and copied-file hashes matched. The earlier pre-upload backup was retained separately. |
| Restore into separate directories | Passed: only the restored copy was started, on the original loopback origin. The original stores were preserved. The active order, receipt, allowance limits/deadlines, paid sale and file claim matched. |
| Fresh-browser recovery from restored storage | Passed: AES-GCM verification succeeded and the downloaded plaintext matched all 39,936 source bytes exactly. |
| Signed order recovery and fresh audit after restore | Blocked: the fresh signer connection timed out, including a retry after the signer was reported ready. Bark remained reconnecting; no post-restore audit started. Local ledger comparison is separate evidence, not a signed HTTP order-recovery pass. |
| Return to original stores | Passed: the restored daemon was stopped, payment state and the unchanged backup were checked, and the original daemon was restarted alone. |
| Operator refund procedure | Not exercised. |
| Independent physical node loss and repair | Not exercised: only one Mac was available. |

No additional purchase, note submission or payment was made during restoration.
Private evidence retains the backup manifest, logical database comparisons,
download comparison and individual signer/audit attempts. Do not publish the
stores, order references, raw audit reports or recovery material.

### Paired-restore completion, 8 October 2026

The same paid order, daemon binary, original signer and isolated restore were
reused. Only one copy of the spendable-note ledger ran at a time. The user
reported the enabled Bark version as 1.3.14. Earlier failures remain recorded
above and in private evidence.

| Check | Observed result |
| --- | --- |
| Signed original-order recovery from restored stores | Passed: the original signer recovered the order as `active`. This status does not extend the original write window or retention deadline. |
| Fresh full-read audit against restored stores | Passed: 1/1 targets and zero failures; the nonce-bound digest was independently recomputed over all 65,608 ciphertext bytes. |
| Fresh-browser file recovery from restored stores | Passed: authenticated decryption and an exact comparison of all 39,936 original plaintext bytes. |
| Payment state and backup preservation | Passed: every logical table in both paired stores matched the baseline, SQLite integrity checks passed, and the offline backup's file hashes were unchanged. No further payment or note submission occurred. |
| Return to original stores | Passed: the restored daemon was stopped before the original restarted alone; original ciphertext read-back matched its expected hash. |

An interrupted retry coincided with a separate firmware-flashing process on the
Heartwood serial port. That observation does not establish a firmware crash or
prove the cause of every earlier timeout. The checks above passed after flashing
ended; the installed Heartwood firmware version was not independently recorded.
This remains one-Mac loopback development evidence, not a hosted TLS deployment,
independent physical failure test or sustained signer reliability result.

### Signer reliability follow-up

Keep the original pairing and paid order. For each cycle, obtain a fresh signed
HTTP authorisation and full-read audit, save the private report, and independently
recompute its digest. An old success message or an unchanged public key is not a
new signing result. Allow normal popup startup time before judging a failure.

1. Record a baseline audit, close the popup, leave the signer idle for at least
   three minutes, then audit again without first opening the popup.
2. Close and reopen Bark's popup, allow it to connect, close it again, and audit.
3. Quit and reopen Chrome with the same profile, recover the saved signed file
   event and original signer, and audit without re-pairing.
4. Take Heartwood offline, confirm a request ends with a bounded failure, restore
   its connection, and require a fresh passing audit with the same pairing.

Record the elapsed idle interval and separate user-observed popup/device actions
from browser-observed signing results. Synthetic lifecycle tests complement these
steps but do not establish a pass on the physical device. No new quote, payment,
relay publication or change to signer policy is needed.

### Repeating the paired restore safely

1. Record the exact daemon build, matching configuration, original order and
   expected plaintext/ciphertext hashes privately. Keep the file recovery key
   separately from the operator backup.
2. Stop the designated daemon and verify that its listener and store handles
   have closed. Copy **both** checkout and storage directories, including any
   SQLite sidecars, into a new private backup directory. Check database
   integrity and record file hashes. Never overwrite an earlier backup.
3. Restore into another new private directory. Verify its files against the
   backup before starting it. Use the same binary and configuration, changing
   only the checkout/storage paths. On a single Mac, reuse the original
   loopback bind and public origin while the original daemon remains stopped;
   this preserves the signed URL and checkout origin bindings.
4. Recover the original order using its original signer, retrieve/decrypt the
   saved file in a fresh browser session, compare the downloaded bytes, and run
   a fresh storage audit. Compare the order, receipt, allowance and settlement
   state; do not create a quote or submit a payment during this check.
5. Stop the restored daemon before returning to the original. Compare the
   payment state before deciding which store is authoritative. If a payment,
   note rotation or other financial mutation occurred, do not blindly restart
   the older ledger: preserve both offline and reconcile first. If only the
   read-only checks occurred and payment state is unchanged, restart the
   original daemon and leave the backup and restored copy offline.

At no point may two copies of the spendable-note ledger run concurrently.
An intact backup and an authenticated file download do not replace the signed
order-recovery and fresh-audit checks. Record any blocked step separately.

For each numbered row record date, exact builds, expected result, observed result
and **pass / fail / blocked**. Preserve failed attempts; a later pass does not
erase them. Keep order references, invoices, notes, authorisations, signer and
recovery material out of public evidence. Record service version, price, rail,
redacted outcome, file-hash comparison and audit outcome separately from the
preflight. The automation cannot attest that a human made these observations.

Physical node-loss recovery still needs independent storage machines/sites.
Follow the [physical pool checklist](https://github.com/forgesworn/wildbloom-node/blob/main/docs/PHYSICAL-POOL-ACCEPTANCE.md):
for a 2-of-4 layout, verify four parts, take two destinations offline, recover
from the remaining two in a fresh browser, then exercise approved owner repair
and verify restored parts by read-back. Keep the owner's repair host separate.
With only this Mac, that row remains blocked; local processes and hosted runners
cannot establish independent power, network or storage failure domains.

The existing `npm run acceptance:pool:quick` remains the fast local regression
test; `npm run acceptance:services` exercises this preflight against the real
daemon and synthetic receiving services. Neither spends real money or completes
this live/physical ceremony.
