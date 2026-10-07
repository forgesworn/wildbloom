import { decodeBolt11 } from "farrier-kit/bolt11";
import { assertHex64, normaliseBlossomServer } from "./security.js";
import {
  integer,
  record,
  requestJson,
  text,
  type Buyer,
  type ServiceOptions,
} from "./services-http.js";

export interface Offer {
  id: string;
  revision: number;
  capacity_bytes: number;
  duration_seconds: number;
  grace_seconds: number;
  price_msat: number;
  delivery_bytes: number;
  delivery_policy: string;
  retention_policy: string;
  refund_policy: string;
}
export interface Issuer {
  id: string;
  note_endpoint: string;
  callback: string;
  mint_pubkey: string;
}
export interface Offers {
  version: 1;
  seller_id: string;
  seller_name: string;
  node_origin: string;
  network: "bitcoin" | "testnet" | "regtest";
  offers: Offer[];
  rails: ("lightning" | "lnurlcash")[];
  issuers: Issuer[];
}
export interface Quote {
  version: 1;
  order_id: string;
  seller_id: string;
  seller_name: string;
  node_origin: string;
  signer_pubkey: string;
  network: Offers["network"];
  rail: Offers["rails"][number];
  issuer_id: string | null;
  issuer: Issuer | null;
  offer: Offer;
  created_at: number;
  expires_at: number;
  renews: string | null;
}
export interface Order {
  quote: Quote;
  quote_digest: string;
  state: string;
  invoice: string | null;
  receipt: {
    allowance_id: string;
    capacity_bytes: number;
    starts_at: number;
    writes_until: number;
    retains_until: number;
  } | null;
}
export interface OrderReference {
  type: "wildbloom.order";
  version: 1;
  origin: string;
  order_id: string;
  buyer: string;
  quote_digest: string;
}
const ID = /^[a-zA-Z0-9_-]{1,128}$/u;
function id(value: unknown): string {
  const result = text(value, 128);
  if (!ID.test(result)) throw new Error("Invalid service identifier.");
  return result;
}
function timestamp(value: unknown): number {
  const result = integer(value);
  if (result > 253402300799) throw new Error("Invalid service timestamp.");
  return result;
}
function endpoint(origin: string, options: ServiceOptions): string {
  if (options.profile === "tor")
    throw new Error(
      "Paid checkout is unavailable in Tor-only mode; no clearnet fallback.",
    );
  return `${normaliseBlossomServer(origin, "direct")}/`;
}
function offer(value: unknown): Offer {
  const v = record(value);
  const result: Offer = {
    id: id(v.id),
    revision: integer(v.revision, 1),
    capacity_bytes: integer(v.capacity_bytes, 1),
    duration_seconds: integer(v.duration_seconds, 1),
    grace_seconds: integer(v.grace_seconds),
    price_msat: integer(v.price_msat, 1),
    delivery_bytes: integer(v.delivery_bytes, 1),
    delivery_policy: text(v.delivery_policy, 2048),
    retention_policy: text(v.retention_policy, 2048),
    refund_policy: text(v.refund_policy, 2048),
  };
  if (result.price_msat % 1000)
    throw new Error("Invalid service price; whole sats required.");
  return result;
}
function network(value: unknown): Offers["network"] {
  if (value !== "bitcoin" && value !== "testnet" && value !== "regtest")
    throw new Error("Invalid service network.");
  return value;
}
function rail(value: unknown): Offers["rails"][number] {
  if (value !== "lightning" && value !== "lnurlcash")
    throw new Error("Invalid service payment method.");
  return value;
}
function issuer(value: unknown): Issuer {
  const v = record(value);
  const key = text(v.mint_pubkey, 66);
  if (!/^(02|03)[0-9a-f]{64}$/u.test(key))
    throw new Error("Invalid service issuer key.");
  const note = new URL(text(v.note_endpoint, 2048));
  const callback = new URL(text(v.callback, 2048));
  for (const u of [note, callback]) {
    normaliseBlossomServer(u.origin, "direct");
    if (u.username || u.password || u.search || u.hash)
      throw new Error("Invalid service issuer URL.");
  }
  if (note.origin !== callback.origin)
    throw new Error("Invalid service issuer origin.");
  return {
    id: id(v.id),
    note_endpoint: note.href,
    callback: callback.href,
    mint_pubkey: key,
  };
}
export function validateOffers(
  value: unknown,
  origin: string,
  options: ServiceOptions = {},
): Offers {
  const v = record(value);
  if (
    v.version !== 1 ||
    v.node_origin !== endpoint(origin, options) ||
    !Array.isArray(v.offers) ||
    !v.offers.length ||
    v.offers.length > 32 ||
    !Array.isArray(v.rails) ||
    !v.rails.length ||
    v.rails.length > 2 ||
    !Array.isArray(v.issuers) ||
    v.issuers.length > 32
  )
    throw new Error("Invalid service offers.");
  const result: Offers = {
    version: 1,
    seller_id: id(v.seller_id),
    seller_name: text(v.seller_name),
    node_origin: v.node_origin,
    network: network(v.network),
    offers: v.offers.map(offer),
    rails: v.rails.map(rail),
    issuers: v.issuers.map(issuer),
  };
  if (
    new Set(result.offers.map((o) => o.id)).size !== result.offers.length ||
    new Set(result.issuers.map((i) => i.id)).size !== result.issuers.length
  )
    throw new Error("Invalid service duplicate identifiers.");
  return result;
}
export async function fetchOffers(
  origin: string,
  options: ServiceOptions = {},
): Promise<Offers> {
  const base = endpoint(origin, options);
  return validateOffers(
    await requestJson(
      base,
      "/checkout/v1/offers",
      undefined,
      undefined,
      options,
    ),
    base,
    options,
  );
}
export function validateOrder(
  value: unknown,
  origin: string,
  buyer: string,
  options: ServiceOptions = {},
): Order {
  const v = record(value);
  const q = record(v.quote);
  if (
    q.version !== 1 ||
    q.node_origin !== endpoint(origin, options) ||
    q.signer_pubkey !== assertHex64(buyer, "Buyer")
  )
    throw new Error("Invalid service quote binding.");
  const quote: Quote = {
    version: 1,
    order_id: id(q.order_id),
    seller_id: id(q.seller_id),
    seller_name: text(q.seller_name),
    node_origin: q.node_origin,
    signer_pubkey: buyer,
    network: network(q.network),
    rail: rail(q.rail),
    issuer_id: q.issuer_id === null ? null : id(q.issuer_id),
    issuer: q.issuer === null ? null : issuer(q.issuer),
    offer: offer(q.offer),
    created_at: timestamp(q.created_at),
    expires_at: timestamp(q.expires_at),
    renews: q.renews === null ? null : id(q.renews),
  };
  if (
    quote.expires_at <= quote.created_at ||
    quote.expires_at - quote.created_at > 86400 ||
    (quote.rail === "lightning" && (quote.issuer || quote.issuer_id)) ||
    (quote.rail === "lnurlcash" &&
      (!quote.issuer ||
        quote.issuer_id !== quote.issuer.id ||
        quote.network !== "bitcoin"))
  )
    throw new Error("Invalid service quote terms.");
  const state = text(v.state, 32);
  if (
    ![
      "reserving",
      "quoted",
      "expired",
      "invoice_pending",
      "awaiting_payment",
      "lnurl_pending",
      "settled",
      "active",
      "refund_required",
    ].includes(state)
  )
    throw new Error("Invalid service order state.");
  const invoice = v.invoice === null ? null : text(v.invoice, 8192);
  if (invoice) {
    const decoded = decodeBolt11(invoice);
    if (
      quote.rail !== "lightning" ||
      decoded.amountMsats !== BigInt(quote.offer.price_msat) ||
      decoded.network !==
        ({ bitcoin: "bc", testnet: "tb", regtest: "bcrt" } as const)[
          quote.network
        ] ||
      decoded.timestamp < quote.created_at - 30 ||
      decoded.timestamp + decoded.expirySeconds > quote.expires_at
    )
      throw new Error("Invalid service invoice amount, network or expiry.");
  }
  const receipt = v.receipt === null ? null : record(v.receipt);
  const parsed =
    receipt === null
      ? null
      : {
          allowance_id: id(receipt.allowance_id),
          capacity_bytes: integer(receipt.capacity_bytes, 1),
          starts_at: timestamp(receipt.starts_at),
          writes_until: timestamp(receipt.writes_until),
          retains_until: timestamp(receipt.retains_until),
        };
  if (
    (state === "active" && !parsed) ||
    (parsed &&
      (parsed.capacity_bytes !== quote.offer.capacity_bytes ||
        parsed.writes_until <= parsed.starts_at ||
        parsed.retains_until < parsed.writes_until))
  )
    throw new Error("Invalid service allowance receipt.");
  return {
    quote,
    quote_digest: assertHex64(text(v.quote_digest, 64), "Quote commitment"),
    state,
    invoice,
    receipt: parsed,
  };
}
export async function createOrder(
  offers: Offers,
  offerId: string,
  method: Offers["rails"][number],
  issuerId: string | null,
  buyer: Buyer,
  requestId: string,
  options: ServiceOptions = {},
  renews: string | null = null,
): Promise<Order> {
  endpoint(offers.node_origin, options);
  const selected = offers.offers.find((o) => o.id === offerId);
  if (
    !selected ||
    !offers.rails.includes(method) ||
    (method === "lnurlcash" &&
      !offers.issuers.some((i) => i.id === issuerId)) ||
    (method === "lightning" && issuerId !== null)
  )
    throw new Error("Choose an offered payment method and storage plan.");
  const order = validateOrder(
    await requestJson(
      offers.node_origin,
      "/checkout/v1/orders",
      {
        request_id: id(requestId),
        offer_id: id(offerId),
        rail: method,
        issuer_id: issuerId,
        renews: renews === null ? null : id(renews),
      },
      buyer,
      options,
    ),
    offers.node_origin,
    buyer.pubkey,
    options,
  );
  const selectedIssuer =
    method === "lnurlcash"
      ? offers.issuers.find((i) => i.id === issuerId)!
      : null;
  if (
    order.quote.seller_name !== offers.seller_name ||
    JSON.stringify(order.quote.issuer) !== JSON.stringify(selectedIssuer) ||
    order.quote.seller_id !== offers.seller_id ||
    order.quote.network !== offers.network ||
    order.quote.rail !== method ||
    order.quote.issuer_id !== issuerId ||
    order.quote.renews !== renews ||
    JSON.stringify(order.quote.offer) !== JSON.stringify(selected)
  )
    throw new Error(
      "Service quote changed; reload offers and review the new terms.",
    );
  return order;
}
export async function orderAction(
  order: Order,
  action: "lightning" | "lnurlcash" | "check",
  buyer: Buyer,
  options: ServiceOptions = {},
  note?: string,
): Promise<Order> {
  endpoint(order.quote.node_origin, options);
  if (
    action !== "check" &&
    (order.quote.rail !== action || Date.now() / 1000 >= order.quote.expires_at)
  )
    throw new Error("Quote expired or wrong payment method.");
  if (action === "lnurlcash" && (!note || note.length > 12000))
    throw new Error("Enter one exact-value LNURLcash note.");
  const body = {
    quote_digest: order.quote_digest,
    ...(action === "lnurlcash" ? { note } : {}),
  };
  const next = validateOrder(
    await requestJson(
      order.quote.node_origin,
      `/checkout/v1/orders/${id(order.quote.order_id)}/${action}`,
      body,
      buyer,
      options,
    ),
    order.quote.node_origin,
    buyer.pubkey,
    options,
  );
  if (
    next.quote_digest !== order.quote_digest ||
    JSON.stringify(next.quote) !== JSON.stringify(order.quote)
  )
    throw new Error("Service changed an existing quote.");
  return next;
}
export function orderReference(order: Order): OrderReference {
  return {
    type: "wildbloom.order",
    version: 1,
    origin: order.quote.node_origin,
    order_id: order.quote.order_id,
    buyer: order.quote.signer_pubkey,
    quote_digest: order.quote_digest,
  };
}
export function parseOrderReference(
  json: string,
  options: ServiceOptions = {},
): OrderReference {
  if (json.length > 4096) throw new Error("Order reference is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid private order reference.");
  }
  const v = record(parsed);
  if (
    v.type !== "wildbloom.order" ||
    v.version !== 1 ||
    Object.keys(v).length !== 6
  )
    throw new Error("Invalid order reference.");
  return {
    type: "wildbloom.order",
    version: 1,
    origin: endpoint(text(v.origin, 2048), options),
    order_id: id(v.order_id),
    buyer: assertHex64(text(v.buyer, 64), "Buyer"),
    quote_digest: assertHex64(text(v.quote_digest, 64), "Quote commitment"),
  };
}
export async function recoverOrder(
  reference: OrderReference,
  buyer: Buyer,
  options: ServiceOptions = {},
): Promise<Order> {
  const ref = parseOrderReference(JSON.stringify(reference), options);
  if (ref.buyer !== buyer.pubkey)
    throw new Error("Connect the original buyer's signer.");
  const result = validateOrder(
    await requestJson(
      ref.origin,
      `/checkout/v1/orders/${ref.order_id}`,
      undefined,
      buyer,
      options,
    ),
    ref.origin,
    buyer.pubkey,
    options,
  );
  if (
    result.quote.order_id !== ref.order_id ||
    result.quote_digest !== ref.quote_digest
  )
    throw new Error("Service returned a different order.");
  return result;
}
