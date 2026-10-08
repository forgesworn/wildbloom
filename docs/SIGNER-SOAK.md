# Evening Bark and Heartwood acceptance

This is a supervised reliability run against the existing paid fixture and
pairing. Nothing here creates another quote, makes a payment, uploads a file,
publishes an event, resets a pairing or changes signer policy. Keep the live
report and any order or recovery material private.

## Before starting

Record the date, Chrome and enabled Bark versions, Heartwood firmware, Wildbloom
source/build and exact node build. Confirm there is only one enabled Bark copy.
Use the existing Chrome profile and Heartwood pairing. Allow Bark its normal
startup time. Keep the Mac awake for the observed idle intervals; if it sleeps,
record that interruption rather than counting the interval as an idle pass.

Recover the original signed fixture event and connect the original signer.
In **Node services**, expand **Verify storage with a fresh challenge**, read
and select its consent, then run the audit. Expect one verified target and no
failures. Save each offered `wildbloom-storage-audit.json` with a distinct name
in a private directory. Do not overwrite a failed attempt with a retry.

## Run sheet

Use a six-hour observation window tonight, with a baseline, checks near 30
minutes, two hours and six hours, plus the deliberate transitions below.
These are scheduled human checks, not an unattended job. No background signing
has been installed or started. Record actual times, including missed checks.

| Cycle | Action | Pass evidence |
| --- | --- | --- |
| Baseline | Run an audit with Heartwood online | New report, one target, zero failures |
| Closed popup | Close Bark's popup, wait at least three minutes, audit without reopening it | Observed popup action and idle interval, new successful report |
| Popup reopen | Open Bark, allow it to connect, close it, then audit | Observed connected state, new successful report |
| Longer idle | At each planned check, audit before opening Bark | Actual idle interval and new successful report |
| Chrome restart | Save recovery material, quit Chrome completely, reopen the same profile, recover the fixture and audit | No re-pairing or policy change, new successful report |
| Heartwood offline | Switch it off and start one audit | Bounded failure, usable retry button, saved failure report and elapsed time |
| Heartwood returns | Restore Wi-Fi and remote signing, retry | New successful report using the original pairing |

If a request remains pending for more than six minutes, record a failure and
cancel it. Do not queue more requests behind it. Record crashes, unexpected
approval prompts, manual resets and every failed attempt even if a retry later
succeeds. An offline signer failure does not demonstrate storage loss.

For each row record **pass / fail / blocked / not run**, start/end times,
observed device/popup state, report filename and any intervention. The planned
offline failure is an expected negative result, not a successful storage proof.
After the last cycle, keep the original daemon as the sole running ledger;
this test needs no backup restore or second daemon.

## Independently check saved successful reports

Use the original encrypted fixture bytes, not the decrypted recovered file.
Take the expected ciphertext SHA-256 and byte count from the retained verified
signed event, and the exact origin from the retained node configuration. Do not
take these commitments from the audit reports being checked.

From the Wildbloom checkout, substitute the private paths and commitments:

```sh
npm run verify:storage-audits -- \
  --blob /private/path/ciphertext.bin \
  --sha256 EXPECTED_CIPHERTEXT_SHA256 \
  --size EXPECTED_CIPHERTEXT_BYTES \
  --origin https://your-existing-node.example \
  --report /private/path/baseline.json \
  --report /private/path/after-idle.json \
  --output /private/path/new-redacted-result.json
```

Repeat `--report` for every successful attempt in the run, in one invocation
(2 to 64 reports). This detects a duplicated nonce across the complete supplied
set. The deliberately failed offline report and any other failed attempts stay
with the run sheet; the verifier refuses reports with failures, missing targets
or multiple targets. This helper is for the existing single-file fixture, not
pool-wide acceptance.

The verifier streams the ciphertext locally, checks its pinned hash and size,
then independently recomputes every domain-separated challenge digest. It
does not access the network, signer, wallet, plaintext or decryption key. Output
is created exclusively with owner-only permissions on POSIX systems; an existing
output is never overwritten. The redacted result excludes origins, file paths,
hashes, nonces and timestamps. Keep command arguments and raw reports private.

Saved reports and their timestamps are unsigned. Anyone holding the ciphertext
can calculate a matching digest. Consequently, an offline result cannot prove
fresh HTTP authorisation, signer identity, timing, device actions, continuous
retention or a passed soak test. Correlate it with the contemporaneous run sheet
and live browser observations. Missing human observations remain unverified.

## Completion

Retain failed attempts alongside successful ones. Summarise the observed window,
number of completed cycles, failures and interventions, digest-verifier result,
and the exact builds. Do not claim 24-hour reliability from a six-hour run or
physical node independence from this single-Mac setup. Spoken screen-reader,
physical mobile and independent security review remain separate gates.
