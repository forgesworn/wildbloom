import { createHash } from "node:crypto";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  httpTemplate,
  integer,
  record,
  requestJson,
  text,
  type Buyer,
} from "../src/core/services-http.js";

const secret = new Uint8Array(32).fill(42);
export const buyer: Buyer = {
  pubkey: getPublicKey(secret),
  signer: {
    getPublicKey: async () => getPublicKey(secret),
    signEvent: async (template) => finalizeEvent(template, secret),
  },
};
const origin = "https://node.example";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("private service transport", () => {
  it("signs the exact URL, method and UTF-8 body; sends no cookies or referrer", async () => {
    const body = { note: "synthetic-é" };
    const fetchImpl = vi.fn(async (url, init) => {
      expect(url).toBe(origin + "/checkout/v1/orders/a/lnurlcash");
      expect(init).toMatchObject({
        method: "POST",
        body: JSON.stringify(body),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      const auth = new Headers(init?.headers).get("authorization")!;
      const event = JSON.parse(
        Buffer.from(auth.slice(6), "base64").toString("utf8"),
      );
      expect(verifyEvent(event)).toBe(true);
      expect(event.tags).toEqual([
        ["u", url],
        ["method", "POST"],
        [
          "payload",
          createHash("sha256").update(JSON.stringify(body)).digest("hex"),
        ],
      ]);
      return Response.json({ ok: true });
    }) as typeof fetch;
    expect(
      await requestJson(
        origin,
        "/checkout/v1/orders/a/lnurlcash",
        body,
        buyer,
        { fetchImpl },
      ),
    ).toEqual({ ok: true });
    expect((await httpTemplate(origin, "GET", "")).tags).toEqual([
      ["u", origin],
      ["method", "GET"],
    ]);
  });
  it("does not sign public offer reads", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(init?.method).toBe("GET");
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetchImpl);
    await requestJson(origin, "/checkout/v1/offers", undefined, undefined);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each([
    "/checkout/v1/orders/a/other",
    "/checkout/v1/orders/a?x=y",
    "/storage/v1/proof/",
    "/../orders",
  ])("refuses an unrecognised route %s", async (path) => {
    await expect(requestJson(origin, path, {}, buyer)).rejects.toThrow(/path/u);
  });
  it("rejects excessive requests and invalid timeouts before fetching", async () => {
    await expect(
      requestJson(origin, "/storage/v1/proof", "x".repeat(16384), buyer),
    ).rejects.toThrow(/too large/u);
    await expect(
      requestJson(origin, "/storage/v1/proof", {}, buyer, { timeoutMs: 0 }),
    ).rejects.toThrow(/timeout/u);
  });
  it("bounds responses, checks MIME and sanitises arbitrary backend errors", async () => {
    for (const response of [
      new Response("secret", { status: 502 }),
      new Response("secret", { headers: { "content-type": "text/html" } }),
      new Response(null, { status: 204 }),
    ]) {
      await expect(
        requestJson(origin, "/checkout/v1/offers", undefined, undefined, {
          fetchImpl: async () => response,
        }),
      ).rejects.toThrow(/Service request failed/u);
    }
    await expect(
      requestJson(origin, "/checkout/v1/offers", undefined, undefined, {
        fetchImpl: async () => Response.json("x".repeat(65536)),
      }),
    ).rejects.toThrow(/too large/u);
    for (const bytes of ["bad JSON", new Uint8Array([0xff])]) {
      await expect(
        requestJson(origin, "/checkout/v1/offers", undefined, undefined, {
          fetchImpl: async () =>
            new Response(bytes, {
              headers: { "content-type": "application/json" },
            }),
        }),
      ).rejects.toThrow("Invalid service JSON response.");
    }
    await expect(
      requestJson(origin, "/checkout/v1/offers", undefined, undefined, {
        fetchImpl: async () => {
          throw new Error("https://secret.example/token");
        },
      }),
    ).rejects.toThrow(
      "Service action failed; check the same order before attempting another payment.",
    );
  });
  it("reports signer failure without leaking signer text or sending a request", async () => {
    const fetchImpl = vi.fn();
    const onPhase = vi.fn();
    const rejecting = { ...buyer, signer: { ...buyer.signer, signEvent: async () => {
      throw new Error("Service secret https://private.example/token");
    } } };
    await expect(requestJson(origin, "/storage/v1/proof", {}, rejecting, { fetchImpl, onPhase }))
      .rejects.toMatchObject({ code: "signer", message: "Signer approval failed or the returned signature was invalid. Check your signer and retry." });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onPhase.mock.calls).toEqual([["signing"]]);
  });
  it("distinguishes audit HTTP and network failures without payment advice or remote error text", async () => {
    const onPhase = vi.fn();
    await expect(requestJson(origin, "/storage/v1/proof", {}, buyer, {
      onPhase, fetchImpl: async () => new Response("private server details", { status: 403 }),
    })).rejects.toMatchObject({ code: "http", status: 403, message: "Service request failed (HTTP 403); the storage audit was not verified." });
    expect(onPhase.mock.calls).toEqual([["signing"], ["request"]]);
    await expect(requestJson(origin, "/storage/v1/proof", {}, buyer, {
      fetchImpl: async () => { throw new Error("Service private backend token"); },
    })).rejects.toMatchObject({ code: "network", message: "Storage audit request failed; check node connectivity and browser access." });
  });
  it("never sends a cancelled or stale signature", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn();
    controller.abort();
    await expect(
      requestJson(origin, "/storage/v1/proof", {}, buyer, {
        fetchImpl,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/u);
    const later = new AbortController();
    const cancelling = {
      ...buyer,
      signer: {
        ...buyer.signer,
        signEvent: async (t: Parameters<typeof finalizeEvent>[0]) => {
          later.abort();
          return finalizeEvent(t, secret);
        },
      },
    };
    await expect(
      requestJson(origin, "/storage/v1/proof", {}, cancelling, {
        fetchImpl,
        signal: later.signal,
      }),
    ).rejects.toThrow(/cancelled/u);
    vi.useFakeTimers();
    const stale = {
      ...buyer,
      signer: {
        ...buyer.signer,
        signEvent: async (t: Parameters<typeof finalizeEvent>[0]) => {
          vi.setSystemTime(Date.now() + 56000);
          return finalizeEvent(t, secret);
        },
      },
    };
    await expect(
      requestJson(origin, "/storage/v1/proof", {}, stale, { fetchImpl }),
    ).rejects.toThrow(/Signature expired/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("aborts a stalled network request at its deadline", async () => {
    vi.useFakeTimers();
    const pending = requestJson(
      origin,
      "/checkout/v1/offers",
      undefined,
      undefined,
      {
        timeoutMs: 100,
        fetchImpl: async (_u, init) =>
          new Promise((_resolve, reject) =>
            init!.signal!.addEventListener("abort", () =>
              reject(new Error("aborted")),
            ),
          ),
      },
    );
    const assertion = expect(pending).rejects.toThrow(/timed out/u);
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
  });
  it("validates primitive service fields", () => {
    for (const v of [null, [], "", 5]) expect(() => record(v)).toThrow();
    for (const v of [null, "", "a\0", "x".repeat(257)])
      expect(() => text(v)).toThrow();
    for (const v of [-1, NaN, Infinity, 0.1, "1", Number.MAX_SAFE_INTEGER + 1])
      expect(() => integer(v)).toThrow();
    expect(record({ a: 1 })).toEqual({ a: 1 });
    expect(text("A policy\nsecond line")).toContain("policy");
    expect(integer(0)).toBe(0);
  });
});
