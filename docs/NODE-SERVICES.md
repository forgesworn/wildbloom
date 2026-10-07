# Node discovery, paid storage and private audits

These source features require a compatible Wildbloom Node. Publishing this source
does not upgrade an existing site, daemon, installer, wallet or mint. Each action
is separate; the browser performs no service discovery, payment check or audit
on page load. Changing profile, signer, node or file clears stale service consent.

## Discover nodes

Enter trusted public keys and your own relays, then select **Find nodes on my
relays**. The browser requests signed [BUD-03](https://github.com/hzrd149/blossom/blob/master/buds/03.md)
kind 10063 lists, validates signatures, and uses the latest valid list per trusted
author (equal timestamps choose the lowest event ID). Lists older than 30 days,
more than 30 seconds ahead, oversized events and invalid endpoints are refused.
There are at most eight relays, 16 authors and 16 servers per list; subscriptions
close after the response or ten seconds. Tor-only mode filters out clearnet nodes.

Discovery contacts only the chosen relays. Relays see the requested author keys;
they can censor or omit results. Selecting a result fills the Blossom endpoint.
It does not probe the node, upload data, add repair authority, buy storage or
establish an independent failure domain. Pool membership remains an explicit
choice in the pool configuration and signed receipt.

The separate **Sign and publish my server list** action replaces the user's
public list with the selected node after disclosure and consent. It permanently
links the node address to that public key. No private storage offers, file
receipts or payment records are placed in this list.

## Buy directly from an operator

1. Select a node, connect NIP-07 or an external signer and load its offers.
2. Review seller, capacity, term, price, recovery grace, delivery and refund terms.
   Request a private quote; capacity is reserved before a payment is offered.
3. Save the private order-reference JSON. Confirm the quote and create a
   Lightning invoice or submit one exact-value LNURLcash note.
4. Pay in your wallet, then explicitly check the same payment. LNURLcash may
   activate immediately after certificate-verified rotation. There is no polling.
5. After activation, select and upload the file in the normal publishing flow.
   Paid nodes may return opaque MIME descriptors; signed MIME, exact byte hash
   and size remain bound to the locally inspected payload.

Each operator receives directly. No ForgeSworn account, monetary balance, custody,
exchange or onward distribution is introduced. A quote buys storage on that one
node, not pool-wide redundancy. Delivery is **operator-managed and not metered
by Wildbloom**. The first core permits one stable allowance per signer; enter its
allowance ID to renew with the same capacity. Capacity upgrades are not supported.

The browser validates returned contract fields, unchanged price/issuer, invoice
network/amount/expiry and activation receipt. `farrier-kit/bolt11` decodes invoice
fields; the daemon uses `lightning-invoice` for full signature validation and the
wallet independently verifies its payment request. Invalid/missing settlement
proof cannot activate storage.

Checkout uses private exact [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md)
URL/method/body authorisations, not BUD upload authorisation or public relay
events. Notes and invoices are not persisted in browser storage. The input note
is cleared before submission. The private reference contains only origin, order
ID, buyer and quote commitment, not a bearer asset or decryption key.

After a timeout, reload or cancellation, use **Recover order with its original
signer**, review the original terms, then check that same order. Do not create a
second payment to resolve uncertainty. A pending invoice creation may require
the operator's original-invoice recovery tool. `refund_required` means the
operator received payment but must resolve fulfilment or refund directly; it is
not an automatic refund. Save the reference before changing file/profile.

Checkout is direct-mode only. It refuses Tor-only checkout without a clearnet
fallback; wallets have their own network behaviour. Storage itself still works
over Tor. See [Node configuration and recovery](https://github.com/forgesworn/wildbloom-node/blob/feature/checkout-discovery-proofs/docs/CHECKOUT.md).

## Verify storage

Resolve a signed file event or private pool receipt, acknowledge bandwidth use
and choose **Run full storage audit**. Each node must enable `--storage-proofs`.
The browser issues a fresh random challenge for each file/shard, independently
downloads every byte, verifies the owner's signed SHA-256/size, and recomputes
the nonce-bound full-read digest. Save the resulting private JSON if needed.
No decryption key is needed and nothing is published to relays.

**Recommendation:** use full-read checks with existing scheduled owner repair for
trusted pools. They are simple, check all bytes and fit the current design.
Random Merkle-block sampling would reduce traffic but give probabilistic coverage
and require upload commitments. Specialist proof-of-replication/time schemes add
considerable complexity and require separate cryptographic review.

A passing audit proves retrievability at that check, not continuous retention,
a dedicated copy or future availability. A node could fetch bytes elsewhere on
demand. A failed check may mean overload or connection failure rather than loss.
Use pool health and owner repair to restore redundancy. The existing unattended
owner service already downloads and hash-verifies configured targets; browser
audits are explicit actions and do not install another background task.

Full-read traffic scales with all checked copies. Nodes allow one concurrent
audit and six challenges per minute, with a five-minute scan deadline. Requester
identity, hash, size and timing remain metadata visible to the node. Evidence is
not a server-signed attestation. The [wire contract](https://github.com/forgesworn/wildbloom-node/blob/feature/checkout-discovery-proofs/docs/STORAGE-AUDITS.md)
includes the byte-level digest and precise limits.

## Validation

`npm run ci` covers the existing browser journey and the new contract, discovery,
transport and audit tests. `npm run acceptance:services` additionally uses a real
Node daemon and loopback-only synthetic receiving services:

```sh
# In the corresponding Node checkout:
cargo build --locked -p wildbloomd -p wildbloom-checkout --bin wildbloomd --example checkout_fixture
# In this checkout:
npm run build
WILDBLOOM_NODE_BIN=/absolute/path/to/target/debug/wildbloomd \
WILDBLOOM_CHECKOUT_FIXTURE=/absolute/path/to/target/debug/examples/checkout_fixture \
  npm run acceptance:services
```

The controlled Chromium journey passed on 7 October 2026: discovery without node
probes, exact manual signing, unpaid-upload denial, Lightning activation, one
invoice across checks, restart/order recovery, paid encrypted upload, fresh audit,
corrupt-data refusal, LNURLcash renewal, no payment/proof relay publication, no
browser persistence and accessibility checks on expanded service controls.

The same journey also passed in [hosted acceptance](https://github.com/forgesworn/wildbloom/actions/runs/37596366685)
against Node source `ce4bceaea65b3a2992933ecaa38aa7545a79e044`.
The browser release was [deployed and verified](https://github.com/forgesworn/wildbloom/actions/runs/37600723199)
from `24e8f0b064e5c4f22e6aaf142bd6cfc3116d85ea`.

This is one-host synthetic acceptance. Real Phoenixd/issuer acceptance, deployed
credentials, refunds and paired backup/restore remain separate. It is not evidence
of a production payment deployment, physical multi-device custody or independent
security review.
