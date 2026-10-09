import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";
import {
  createOrder,
  customerReceipt,
  fetchOffers,
  orderAction,
  orderReference,
  parseOrderReference,
  recoverOrder,
  validateOffers,
  validateOrder,
  type Offers,
  type Order,
} from "../src/core/checkout.js";
import type { Buyer } from "../src/core/services-http.js";
const secret = new Uint8Array(32).fill(42);
const buyer: Buyer = {
  pubkey: getPublicKey(secret),
  signer: {
    getPublicKey: async () => getPublicKey(secret),
    signEvent: async (t) => finalizeEvent(t, secret),
  },
};
const origin = "https://node.example/";
const offers: Offers = {
  version: 1,
  seller_id: "operator",
  seller_name: "Operator",
  node_origin: origin,
  network: "bitcoin",
  offers: [
    {
      id: "small",
      revision: 1,
      capacity_bytes: 1000,
      duration_seconds: 3600,
      grace_seconds: 60,
      price_msat: 10000,
      delivery_bytes: 1000,
      delivery_policy: "Included, operator-managed",
      retention_policy: "One hour",
      refund_policy: "Contact operator",
    },
  ],
  rails: ["lightning", "lnurlcash"],
  issuers: [
    {
      id: "mint",
      note_endpoint: "https://mint.example/w",
      callback: "https://mint.example/callback",
      mint_pubkey: "02" + "ab".repeat(32),
    },
  ],
};
function order(lnurl = false): Order {
  const now = Math.floor(Date.now() / 1000);
  return {
    quote: {
      version: 1,
      order_id: "order",
      seller_id: offers.seller_id,
      seller_name: offers.seller_name,
      node_origin: origin,
      signer_pubkey: buyer.pubkey,
      network: "bitcoin",
      rail: lnurl ? "lnurlcash" : "lightning",
      issuer_id: lnurl ? "mint" : null,
      issuer: lnurl ? offers.issuers[0]! : null,
      offer: { ...offers.offers[0]! },
      created_at: now,
      expires_at: now + 600,
      renews: null,
      refund_to: null,
    },
    quote_digest: "ab".repeat(32),
    state: "quoted",
    invoice: null,
    receipt: null,
    refund: null,
  };
}
const options = (value: unknown) => ({
  fetchImpl: vi.fn(async () => Response.json(value)),
});
describe("paid storage contracts", () => {
  it("reads offers and binds a quote to the reviewed offer and issuer", async () => {
    expect(await fetchOffers(origin, options(offers))).toEqual(offers);
    for (const note of [false, true]) {
      const q = order(note);
      expect(
        await createOrder(
          offers,
          "small",
          q.quote.rail,
          q.quote.issuer_id,
          buyer,
          "request",
          options(q),
        ),
      ).toEqual(q);
    }
    const q = order(true);
    q.quote.issuer = {
      ...q.quote.issuer!,
      mint_pubkey: "03" + "cd".repeat(32),
    };
    await expect(
      createOrder(
        offers,
        "small",
        "lnurlcash",
        "mint",
        buyer,
        "request",
        options(q),
      ),
    ).rejects.toThrow(/changed/u);
    const changed = order();
    changed.quote.offer.price_msat = 20000;
    await expect(
      createOrder(
        offers,
        "small",
        "lightning",
        null,
        buyer,
        "request",
        options(changed),
      ),
    ).rejects.toThrow(/changed/u);
  });
  it("preserves one exact order across payment, check, private reference and recovery", async () => {
    const q = order();
    const pending = { ...q, state: "invoice_pending" };
    expect(await orderAction(q, "lightning", buyer, options(pending))).toEqual(
      pending,
    );
    const active = {
      ...q,
      state: "active",
      receipt: {
        allowance_id: "allowance",
        capacity_bytes: 1000,
        starts_at: q.quote.created_at,
        writes_until: q.quote.created_at + 3600,
        retains_until: q.quote.created_at + 3660,
      },
    };
    expect(await orderAction(pending, "check", buyer, options(active))).toEqual(
      active,
    );
    const ref = orderReference(active);
    expect(Object.keys(ref)).toHaveLength(6);
    expect(parseOrderReference(JSON.stringify(ref))).toEqual(ref);
    expect(await recoverOrder(ref, buyer, options(active))).toEqual(active);
    expect(JSON.stringify(ref)).not.toMatch(/invoice|note|preimage/u);
    const n = order(true);
    expect(
      await orderAction(n, "lnurlcash", buyer, options(n), "synthetic-note"),
    ).toEqual(n);
    const renewed = order();
    renewed.quote.renews = "old";
    expect(
      await createOrder(
        offers,
        "small",
        "lightning",
        null,
        buyer,
        "request",
        options(renewed),
        "old",
      ),
    ).toEqual(renewed);
  });
  it("binds a private refund address and exports customer allowance and refund receipts", async () => {
    const q = order(true);
    q.quote.refund_to = "buyer@example.com";
    expect(
      await createOrder(
        offers,
        "small",
        "lnurlcash",
        "mint",
        buyer,
        "refund-request",
        options(q),
        null,
        "buyer@example.com",
      ),
    ).toEqual(q);
    const pending = {
      ...q,
      state: "refund_required",
      refund: {
        status: "pending" as const,
        amount_msat: 10000,
        payment_hash: "cd".repeat(32),
        refunded_at: null,
      },
    };
    expect(validateOrder(pending, origin, buyer.pubkey)).toEqual(pending);
    const completed = {
      ...pending,
      state: "refunded",
      refund: {
        ...pending.refund,
        status: "completed" as const,
        refunded_at: q.quote.created_at + 30,
      },
    };
    expect(validateOrder(completed, origin, buyer.pubkey)).toEqual(completed);
    expect(customerReceipt(completed)).toMatchObject({
      type: "wildbloom.storage-receipt",
      version: 1,
      state: "refunded",
      refund: { status: "completed", amount_msat: 10000 },
      purchase: { offer_id: "small", renews: null },
    });
    await expect(
      createOrder(
        offers,
        "small",
        "lnurlcash",
        "mint",
        buyer,
        "bad-refund",
        options(q),
        null,
        "not an address",
      ),
    ).rejects.toThrow(/valid Lightning/u);
  });
  it("fails closed for Tor, changed orders, wrong buyers, expired quotes and missing notes", async () => {
    await expect(fetchOffers(origin, { profile: "tor" })).rejects.toThrow(
      /Tor-only/u,
    );
    const q = order();
    const changed = { ...q, quote_digest: "cd".repeat(32) };
    await expect(
      orderAction(q, "check", buyer, options(changed)),
    ).rejects.toThrow(/changed/u);
    await expect(
      recoverOrder(
        orderReference(q),
        { ...buyer, pubkey: "cc".repeat(32) },
        options(q),
      ),
    ).rejects.toThrow(/original buyer/u);
    await expect(
      recoverOrder(orderReference(q), buyer, options(changed)),
    ).rejects.toThrow(/different order/u);
    q.quote.expires_at = 1;
    await expect(orderAction(q, "lightning", buyer)).rejects.toThrow(
      /expired/u,
    );
    await expect(orderAction(order(), "lnurlcash", buyer)).rejects.toThrow(
      /wrong payment/u,
    );
    for (const note of [undefined, "x".repeat(12001)])
      await expect(
        orderAction(order(true), "lnurlcash", buyer, {}, note),
      ).rejects.toThrow(/exact-value/u);
    for (const [offer, rail, issuer] of [
      ["missing", "lightning", null],
      ["small", "lnurlcash", "missing"],
      ["small", "lightning", "mint"],
    ] as const)
      await expect(
        createOrder(offers, offer, rail, issuer, buyer, "request"),
      ).rejects.toThrow(/Choose/u);
    await expect(
      createOrder(offers, "small", "lightning", null, buyer, "../bad"),
    ).rejects.toThrow(/identifier/u);
  });
  it("rejects malformed and misleading remote offers", () => {
    const bad: unknown[] = [
      null,
      { ...offers, version: 2 },
      { ...offers, node_origin: "https://other.example/" },
      { ...offers, offers: [] },
      { ...offers, rails: [] },
      { ...offers, issuers: null },
      { ...offers, network: "unknown" },
      { ...offers, rails: ["cash"] },
      { ...offers, offers: [offers.offers[0], offers.offers[0]] },
      { ...offers, issuers: [offers.issuers[0], offers.issuers[0]] },
    ];
    for (const value of bad)
      expect(() => validateOffers(value, origin)).toThrow();
    for (const change of [
      { price_msat: 10001 },
      { capacity_bytes: 0 },
      { id: "../x" },
    ])
      expect(() =>
        validateOffers(
          { ...offers, offers: [{ ...offers.offers[0], ...change }] },
          origin,
        ),
      ).toThrow();
    for (const change of [
      { mint_pubkey: "invalid" },
      { callback: "https://elsewhere.example/callback" },
      { note_endpoint: "https://mint.example/w?secret=1" },
      { callback: "http://mint.example/c" },
    ])
      expect(() =>
        validateOffers(
          { ...offers, issuers: [{ ...offers.issuers[0], ...change }] },
          origin,
        ),
      ).toThrow();
  });
  it("rejects quote, invoice, state and allowance substitution", () => {
    const q = order();
    for (const change of [
      { signer_pubkey: "cd".repeat(32) },
      { node_origin: "https://elsewhere.example/" },
      { expires_at: q.quote.created_at },
      { expires_at: q.quote.created_at + 86401 },
      { created_at: Number.MAX_SAFE_INTEGER },
      { issuer_id: "mint" },
      { rail: "lnurlcash" },
    ])
      expect(() =>
        validateOrder(
          { ...q, quote: { ...q.quote, ...change } },
          origin,
          buyer.pubkey,
        ),
      ).toThrow();
    for (const change of [
      { state: "paid-trust-me" },
      { state: "active" },
      { invoice: "not-an-invoice" },
      { quote_digest: "bad" },
      {
        receipt: {
          allowance_id: "x",
          capacity_bytes: 999,
          starts_at: 1,
          writes_until: 2,
          retains_until: 3,
        },
      },
    ])
      expect(() =>
        validateOrder({ ...q, ...change }, origin, buyer.pubkey),
      ).toThrow();
  });
  it("bounds recovery imports and rejects extra bearer fields", () => {
    const ref = orderReference(order());
    for (const json of [
      "x".repeat(4097),
      "{",
      JSON.stringify({ ...ref, note: "bearer" }),
      JSON.stringify({ ...ref, type: "unknown" }),
      JSON.stringify({ ...ref, order_id: "/escape" }),
    ])
      expect(() => parseOrderReference(json)).toThrow();
  });
});
