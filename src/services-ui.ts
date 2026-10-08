import {
  createOrder,
  fetchOffers,
  orderAction,
  orderReference,
  parseOrderReference,
  recoverOrder,
  type Offers,
  type Order,
} from "./core/checkout.js";
import { buildServerList, discoverNodes } from "./core/discovery.js";
import { signEventExactly } from "./core/nostr.js";
import { publishToRelays } from "./core/relay.js";
import { auditFailure, auditStoredBlob, type StorageAudit } from "./core/storage-proof.js";
import type { Buyer } from "./core/services-http.js";
import type { PoolReceipt } from "./core/pool.js";
import type { NetworkProfile, ResolvedHybridEvent } from "./core/types.js";

interface Context {
  profile(): NetworkProfile;
  ready(): void;
  relays(): string[];
  buyer(): Buyer;
  origin(): string;
  selectOrigin(origin: string): void;
  resolved(): ResolvedHybridEvent | null;
  pool(): PoolReceipt | null;
  cancelSigning(): void;
}
export function mountNodeServices(context: Context): { reset(): void } {
  const el = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as T;
  const status = el<HTMLOutputElement>("node-service-status");
  const plan = el<HTMLSelectElement>("checkout-plan");
  const method = el<HTMLSelectElement>("checkout-rail");
  const issuer = el<HTMLSelectElement>("checkout-issuer");
  const note = el<HTMLInputElement>("checkout-note");
  const consent = el<HTMLInputElement>("checkout-consent");
  const reference = el<HTMLTextAreaElement>("checkout-reference");
  let offers: Offers | null = null;
  let order: Order | null = null;
  let requestId = crypto.randomUUID();
  let controller: AbortController | null = null;
  let revision = 0;
  const urls = new Set<string>();
  const buttons = [
    "discover-nodes",
    "publish-server-list",
    "checkout-offers",
    "checkout-quote",
    "checkout-pay",
    "checkout-check",
    "checkout-recover",
    "storage-audit",
  ];
  const revoke = (): void => {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  const output = (target: string, message: string): void => {
    el(target).textContent = message;
  };
  const terms = (o: Offers["offers"][number]): string =>
    `${(o.capacity_bytes / 1024 ** 3).toFixed(3)} GiB of stored bytes for ${o.duration_seconds / 86400} days\nPrice: ${o.price_msat / 1000} sats\nRecovery grace: ${o.grace_seconds / 86400} days\nIncluded delivery (operator-managed, not metered by Wildbloom): ${o.delivery_bytes} bytes. ${o.delivery_policy}\nRetention: ${o.retention_policy}\nRefunds: ${o.refund_policy}`;
  const download = (target: string, name: string, value: unknown): void => {
    const a = document.createElement("a");
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], {
        type: "application/octet-stream",
      }),
    );
    urls.add(url);
    a.href = url;
    a.download = name;
    a.textContent = `Save ${name}`;
    el(target).append(a);
  };
  const renderOrder = (): void => {
    if (!order) return;
    output(
      "checkout-quote-details",
      `${order.quote.seller_name}\n${order.quote.node_origin}\n${terms(order.quote.offer)}\nQuote expires: ${new Date(order.quote.expires_at * 1000).toISOString()}\nState: ${order.state}` +
        (order.receipt
          ? `\nAllowance: ${order.receipt.allowance_id}; writes until ${new Date(order.receipt.writes_until * 1000).toISOString()}`
          : ""),
    );
    output("checkout-receipt-links", "");
    download(
      "checkout-receipt-links",
      "wildbloom-order.json",
      orderReference(order),
    );
    output("checkout-payment", "");
    if (
      order.invoice &&
      order.state === "awaiting_payment" &&
      Date.now() / 1000 < order.quote.expires_at
    ) {
      const p = document.createElement("p");
      p.textContent = order.invoice;
      el("checkout-payment").append(p);
      const a = document.createElement("a");
      a.href = `lightning:${order.invoice}`;
      a.textContent = "Open invoice in my wallet";
      el("checkout-payment").append(a);
    }
    if (order.state === "refund_required")
      output(
        "checkout-payment",
        "Payment received but storage could not be activated. Contact this operator for fulfilment or refund; do not pay again.",
      );
    if (["invoice_pending", "lnurl_pending", "settled"].includes(order.state))
      output(
        "checkout-payment",
        "Payment needs reconciliation. Check this order; never start a second payment to resolve a timeout.",
      );
    if (order.state === "active")
      output(
        "checkout-payment",
        "Storage allowance activated. Choose and upload your file separately. Keep the private order reference for recovery and renewal.",
      );
  };
  const showOffer = (): void => {
    const selected = offers?.offers.find((o) => o.id === plan.value);
    output(
      "checkout-offer-details",
      selected
        ? `${offers!.seller_name} (${offers!.seller_id})\n${offers!.node_origin}\n${terms(selected)}`
        : "",
    );
  };
  const reset = (): void => {
    revision++;
    controller?.abort();
    controller = null;
    offers = null;
    order = null;
    requestId = crypto.randomUUID();
    note.value = "";
    consent.checked = false;
    reference.value = "";
    el<HTMLTextAreaElement>("discovery-keys").value = "";
    el<HTMLInputElement>("checkout-renews").value = "";
    el<HTMLInputElement>("proof-consent").checked = false;
    el<HTMLInputElement>("list-public-consent").checked = false;
    revoke();
    plan.replaceChildren();
    issuer.replaceChildren();
    for (const id of [
      "discovery-results",
      "checkout-offer-details",
      "checkout-quote-details",
      "checkout-receipt-links",
      "checkout-payment",
      "storage-audit-results",
    ])
      output(id, "");
    buttons.forEach((id) => {
      el<HTMLButtonElement>(id).disabled = false;
    });
    status.textContent =
      "Service state cleared. Existing paid orders remain with their operator; recover using your saved reference.";
  };
  const action = (
    id: string,
    run: (
      options: { profile: NetworkProfile; signal: AbortSignal },
      current: () => void,
    ) => Promise<void>,
  ): void => {
    el(id).addEventListener("click", () => {
      if (controller) return;
      const version = revision;
      const work = new AbortController();
      controller = work;
      const current = (): void => {
        work.signal.throwIfAborted();
        if (revision !== version) throw new Error("Service context changed.");
      };
      buttons.forEach((name) => {
        el<HTMLButtonElement>(name).disabled = true;
      });
      status.textContent = "Working…";
      void (async () => {
        context.ready();
        await run({ profile: context.profile(), signal: work.signal }, current);
      })()
        .catch((error: unknown) => {
          if (revision === version)
            status.textContent =
              error instanceof Error ? error.message : "Service action failed.";
        })
        .finally(() => {
          if (revision === version) {
            controller = null;
            buttons.forEach((name) => {
              el<HTMLButtonElement>(name).disabled = false;
            });
          }
        });
    });
  };
  for (const input of [plan, method, issuer, el("checkout-renews")])
    input.addEventListener("change", () => {
      revision++;
      controller?.abort();
      controller = null;
      context.cancelSigning();
      order = null;
      requestId = crypto.randomUUID();
      consent.checked = false;
      note.value = "";
      output("checkout-quote-details", "");
      output("checkout-receipt-links", "");
      output("checkout-payment", "");
      showOffer();
      buttons.forEach((id) => {
        el<HTMLButtonElement>(id).disabled = false;
      });
    });
  const cancel = (): void => {
    revision++;
    controller?.abort();
    controller = null;
    context.cancelSigning();
    buttons.forEach((id) => {
      el<HTMLButtonElement>(id).disabled = false;
    });
    note.value = "";
    consent.checked = false;
    status.textContent =
      "Cancelled locally. An existing payment may still complete; recover or check the same order.";
  };
  el("cancel-node-service").addEventListener("click", cancel);
  el("discovery-keys").addEventListener("input", () => {
    controller?.abort();
    output("discovery-results", "");
  });
  for (const checkbox of [
    consent,
    el<HTMLInputElement>("proof-consent"),
    el<HTMLInputElement>("list-public-consent"),
  ])
    checkbox.addEventListener("change", () => {
      if (!checkbox.checked) cancel();
    });
  action("discover-nodes", async (options, current) => {
    const keys = el<HTMLTextAreaElement>("discovery-keys")
      .value.trim()
      .split(/\s+/u);
    const results = await discoverNodes(context.relays(), keys, options);
    current();
    output("discovery-results", "");
    for (const node of results) {
      const row = document.createElement("p");
      row.textContent = `${node.origin}, recommended by ${node.recommendedBy.join(", ")}. `;
      const choose = document.createElement("button");
      choose.type = "button";
      choose.textContent = "Use this node";
      choose.addEventListener("click", () => context.selectOrigin(node.origin));
      row.append(choose);
      el("discovery-results").append(row);
    }
    status.textContent = `Found ${results.length} nodes. No discovered node has been contacted.`;
  });
  action("publish-server-list", async (options, current) => {
    if (!el<HTMLInputElement>("list-public-consent").checked)
      throw new Error("Confirm public replacement of your server list first.");
    const buyer = context.buyer();
    const event = await signEventExactly(
      buildServerList([context.origin()], options.profile),
      buyer.signer,
      buyer.pubkey,
    );
    current();
    const results = await publishToRelays(
      context.relays(),
      event,
      options.profile,
      options.signal,
    );
    current();
    status.textContent = `Server list accepted by ${results.filter((r) => r.ok).length}/${results.length} relays.`;
  });
  action("checkout-offers", async (options, current) => {
    const result = await fetchOffers(context.origin(), options);
    current();
    offers = result;
    order = null;
    consent.checked = false;
    plan.replaceChildren(
      ...result.offers.map(
        (o) =>
          new Option(
            `${o.id}: ${o.capacity_bytes} bytes for ${o.price_msat / 1000} sats`,
            o.id,
          ),
      ),
    );
    method.replaceChildren(...result.rails.map((r) => new Option(r, r)));
    issuer.replaceChildren(
      ...result.issuers.map((i) => new Option(i.id, i.id)),
    );
    showOffer();
    status.textContent =
      "Offers loaded. Review the operator and terms before requesting a quote.";
  });
  action("checkout-quote", async (options, current) => {
    if (!offers) throw new Error("Load offers first.");
    const rail = method.value as "lightning" | "lnurlcash";
    const result = await createOrder(
      offers,
      plan.value,
      rail,
      rail === "lnurlcash" ? issuer.value : null,
      context.buyer(),
      requestId,
      options,
      el<HTMLInputElement>("checkout-renews").value.trim() || null,
    );
    current();
    order = result;
    consent.checked = false;
    renderOrder();
    status.textContent =
      "Quote reserved. Save its reference and review its terms before payment.";
  });
  action("checkout-pay", async (options, current) => {
    const paymentNote = note.value;
    note.value = "";
    if (!order || !consent.checked)
      throw new Error(
        "Review the quote, save its reference and confirm payment consent first.",
      );
    const result = await orderAction(
      order,
      order.quote.rail,
      context.buyer(),
      options,
      paymentNote,
    );
    current();
    order = result;
    renderOrder();
    status.textContent = `Order: ${order.state}.`;
  });
  action("checkout-check", async (options, current) => {
    if (!order || !consent.checked)
      throw new Error(
        "Recover or review this order and confirm its terms first.",
      );
    const result = await orderAction(order, "check", context.buyer(), options);
    current();
    order = result;
    renderOrder();
    status.textContent = `Order: ${order.state}.`;
  });
  action("checkout-recover", async (options, current) => {
    const ref = parseOrderReference(reference.value, options);
    const result = await recoverOrder(ref, context.buyer(), options);
    current();
    order = result;
    consent.checked = false;
    renderOrder();
    status.textContent = `Recovered order: ${result.state}. Review its original terms before checking settlement.`;
  });
  action("storage-audit", async (options, current) => {
    if (!el<HTMLInputElement>("proof-consent").checked)
      throw new Error(
        "Confirm the full-read audit and its bandwidth use first.",
      );
    const buyer = context.buyer();
    const pool = context.pool();
    const file = context.resolved();
    if (!pool && !file)
      throw new Error("Resolve a signed file or pool receipt first.");
    const jobs: { file: ResolvedHybridEvent; origin: string }[] = pool
      ? pool.manifest.parts.flatMap((part) =>
          part.targets.map((node) => ({
            origin: node.origin,
            file: {
              event: pool.event,
              url: `${node.origin}${part.sha256}`,
              mimeType: "application/octet-stream",
              sha256: part.sha256,
              size: part.size,
              name: "part.bin",
              trackers: [],
            },
          })),
        )
      : [{ file: file!, origin: new URL(file!.url).origin }];
    const proofs: StorageAudit[] = [];
    const failed: string[] = [];
    const failures: { origin: string; sha256: string; stage: string; reason: string }[] = [];
    output("storage-audit-results", "");
    for (const job of jobs) {
      current();
      status.textContent = `Verifying ${proofs.length + failed.length + 1}/${jobs.length} storage targets…`;
      try {
        proofs.push(
          await auditStoredBlob(job.file, job.origin, buyer, {
            ...options,
            onPhase: (phase) => {
              current();
              const target = `${proofs.length + failed.length + 1}/${jobs.length}`;
              status.textContent = phase === "signing"
                ? `Target ${target}: waiting for HTTP-auth approval (kind 27235) in your signer…`
                : `Target ${target}: requesting and independently verifying the storage proof…`;
            },
          }),
        );
      } catch (error) {
        current();
        failed.push(job.origin);
        failures.push({ origin: job.origin, sha256: job.file.sha256, ...auditFailure(error) });
      }
    }
    current();
    output(
      "storage-audit-results",
      `${proofs.length}/${jobs.length} targets verified. ${failed.length} failed or unavailable. Evidence is private and proves current retrievability only. `,
    );
    for (const failure of failures) {
      const line = document.createElement("p");
      line.textContent = `${failure.origin} (${failure.sha256.slice(0, 12)}…): ${failure.reason}`;
      el("storage-audit-results").append(line);
    }
    download("storage-audit-results", "wildbloom-storage-audit.json", {
      version: 1,
      proofs,
      failed,
      failures,
      scope:
        "full-read retrievability; no continuous-retention or dedicated-copy claim",
    });
    status.textContent = failed.length
      ? "Some targets could not be verified. Review the per-target reasons below before retrying or repairing."
      : "All selected targets passed a fresh full-read audit.";
  });
  return { reset };
}
