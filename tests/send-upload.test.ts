import { readFileSync } from "node:fs";
import { verifyEvent } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/core/crypto.js";
import { parseRequestInvitation, type RequestInvitation } from "../src/send/request.js";
import {
  classifyResponse,
  localSigner,
  RETRY_DELAYS_MS,
  sleep,
  TransportNetworkError,
  uploadEnvelope,
  UploadError,
  withRetries,
  type TransportResponse,
  type UploadTransport,
} from "../src/send/upload.js";

const vectors = JSON.parse(readFileSync(new URL("../test-vectors/wildbloom-request-v1.json", import.meta.url), "utf8")) as {
  now: number;
  invitation: { valid: { name: string; invitation: string; pubkey: string; serverTag: string }[] };
};
const NOW = vectors.now;
// The small request to a node on a non-default port: its BUD-11 server tag must be the bare host.
const entry = vectors.invitation.valid.find((candidate) => candidate.name.startsWith("a small request"))!;

function invitation(): RequestInvitation {
  return parseRequestInvitation(new TextEncoder().encode(entry.invitation), NOW);
}

const envelope = new Blob([new Uint8Array(70_000).fill(7)], { type: "application/vnd.forgesworn.encrypted" });
const SHA = await sha256Hex(envelope);

interface Call {
  readonly method: "HEAD" | "PUT";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: Blob;
}

function descriptor(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url: `https://storage.example:8443/${SHA}`,
    sha256: SHA,
    size: envelope.size,
    type: "application/octet-stream",
    uploaded: NOW,
    ...overrides,
  });
}

function fakeTransport(script: { head?: (call: Call) => TransportResponse; put?: (call: Call) => TransportResponse } = {}) {
  const calls: Call[] = [];
  const transport: UploadTransport = {
    head: (request) => {
      const call: Call = { method: "HEAD", url: request.url, headers: { ...request.headers } };
      calls.push(call);
      return Promise.resolve((script.head ?? (() => ({ status: 200, reason: "", body: "" })))(call));
    },
    put: (request) => {
      const call: Call = { method: "PUT", url: request.url, headers: { ...request.headers }, body: request.body };
      calls.push(call);
      request.onProgress?.(request.body.size, request.body.size);
      return Promise.resolve((script.put ?? (() => ({ status: 201, reason: "", body: descriptor() })))(call));
    },
  };
  return { transport, calls };
}

function decodeEvent(header: string): { id: string; pubkey: string; kind: number; created_at: number; tags: string[][]; content: string; sig: string } {
  expect(header.startsWith("Nostr ")).toBe(true);
  return JSON.parse(Buffer.from(header.slice("Nostr ".length), "base64").toString("utf8"));
}

describe("the upload", () => {
  it("preflights, then uploads, each signed by the request key for the node's host", async () => {
    const request = invitation();
    const { transport, calls } = fakeTransport();
    const result = await uploadEnvelope({ invitation: request, envelope, sha256: SHA, transport, now: () => NOW });
    expect(result.sha256).toBe(SHA);
    expect(calls.map((call) => call.method)).toEqual(["HEAD", "PUT"]);
    expect(calls.every((call) => call.url === "https://storage.example:8443/upload")).toBe(true);

    const [head, put] = calls as [Call, Call];
    expect(head.headers).toMatchObject({
      "X-SHA-256": SHA,
      "X-Content-Length": String(envelope.size),
      "X-Content-Type": "application/vnd.forgesworn.encrypted",
    });
    expect(put.headers).toMatchObject({ "X-SHA-256": SHA, "Content-Type": "application/vnd.forgesworn.encrypted" });
    expect(put.body).toBe(envelope);
    // The upload carries the bytes and the content type; the preflight carries neither body nor Content-Type.
    expect(head.body).toBeUndefined();
    expect(head.headers["Content-Type"]).toBeUndefined();

    for (const call of calls) {
      const event = decodeEvent(call.headers.Authorization!);
      expect(verifyEvent(event as never)).toBe(true);
      expect(event.kind).toBe(24_242);
      expect(event.pubkey).toBe(entry.pubkey);
      expect(event.created_at).toBe(NOW - 1);
      expect(event.tags).toEqual([
        ["t", "upload"],
        ["expiration", String(NOW - 1 + 300)],
        // The BUD-11 server tag is the host from the invitation's node: no scheme, no port.
        ["server", entry.serverTag],
        ["x", SHA],
      ]);
      expect(event.content).toBe(`Upload blob ${SHA} to ${entry.serverTag}`);
    }
    expect(entry.serverTag).toBe("storage.example");
    request.dispose();
  });

  it("signs a fresh event for every attempt", async () => {
    // The first vector's grant lasts the full 24 hours, so the clock can move on between attempts.
    const request = parseRequestInvitation(new TextEncoder().encode(vectors.invitation.valid[0]!.invitation), NOW);
    let clock = NOW;
    const { transport, calls } = fakeTransport({ put: () => ({ status: 201, reason: "", body: descriptor({ url: `https://storage.example/${SHA}` }) }) });
    await uploadEnvelope({ invitation: request, envelope, sha256: SHA, transport, now: () => clock });
    clock += 30;
    await uploadEnvelope({ invitation: request, envelope, sha256: SHA, transport, now: () => clock });
    const ids = calls.map((call) => decodeEvent(call.headers.Authorization!).id);
    expect(ids[2]).not.toBe(ids[0]);
    expect(decodeEvent(calls[2]!.headers.Authorization!).created_at).toBe(NOW + 29);
  });

  it("uses a local signer that holds only the request key", async () => {
    const request = invitation();
    const signer = localSigner(request.signer);
    expect(await signer.getPublicKey()).toBe(entry.pubkey);
    const signed = await signer.signEvent({ kind: 24_242, created_at: NOW - 1, tags: [["t", "upload"]], content: "x" });
    expect(verifyEvent(signed)).toBe(true);
    expect(signed.pubkey).toBe(entry.pubkey);
  });

  it("does not send the bytes when the preflight is refused", async () => {
    const request = invitation();
    const { transport, calls } = fakeTransport({ head: () => ({ status: 507, reason: "", body: "" }) });
    await expect(uploadEnvelope({ invitation: request, envelope, sha256: SHA, transport, now: () => NOW })).rejects.toMatchObject({ failure: "no-room", status: 507 });
    expect(calls.map((call) => call.method)).toEqual(["HEAD"]);
  });

  it("starts nothing once the grant has ended", async () => {
    const request = invitation();
    const { transport, calls } = fakeTransport();
    await expect(uploadEnvelope({ invitation: request, envelope, sha256: SHA, transport, now: () => request.until })).rejects.toMatchObject({ failure: "ended" });
    expect(calls).toEqual([]);
  });

  it("calls a dropped connection a network failure, and passes an abort through", async () => {
    const request = invitation();
    const broken: UploadTransport = {
      head: () => Promise.reject(new TransportNetworkError()),
      put: () => Promise.reject(new TransportNetworkError()),
    };
    await expect(uploadEnvelope({ invitation: request, envelope, sha256: SHA, transport: broken, now: () => NOW })).rejects.toMatchObject({ failure: "network" });

    const controller = new AbortController();
    const aborting: UploadTransport = {
      head: () => {
        controller.abort();
        return Promise.reject(new DOMException("Aborted", "AbortError"));
      },
      put: () => Promise.reject(new Error("never reached")),
    };
    await expect(uploadEnvelope({ invitation: request, envelope, sha256: SHA, transport: aborting, signal: controller.signal, now: () => NOW }))
      .rejects.toMatchObject({ name: "AbortError" });
  });

  it("accepts only a descriptor for exactly these bytes on the node's own origin", async () => {
    const request = invitation();
    const wrong = [
      descriptor({ sha256: "ab".repeat(32) }),
      descriptor({ size: envelope.size + 1 }),
      descriptor({ url: `https://elsewhere.example/${SHA}` }),
      descriptor({ url: `https://storage.example:8443/${"ab".repeat(32)}` }),
      "not json",
      "",
    ];
    for (const body of wrong) {
      const { transport } = fakeTransport({ put: () => ({ status: 200, reason: "", body }) });
      await expect(uploadEnvelope({ invitation: request, envelope, sha256: SHA, transport, now: () => NOW })).rejects.toMatchObject({ failure: "refused" });
    }
  });

  it("reports progress from the transport", async () => {
    const request = invitation();
    const { transport } = fakeTransport();
    const onProgress = vi.fn();
    await uploadEnvelope({ invitation: request, envelope, sha256: SHA, transport, now: () => NOW, onProgress });
    expect(onProgress).toHaveBeenCalledWith(envelope.size, envelope.size);
  });
});

describe("how a node answer is read", () => {
  const response = (status: number, reason = "", body = ""): TransportResponse => ({ status, reason, body });

  it("treats 2xx as success", () => {
    for (const status of [200, 201, 204]) expect(classifyResponse(response(status))).toBeUndefined();
  });

  it("maps each refusal to its screen", () => {
    expect(classifyResponse(response(403, "request_ended"))).toBe("ended");
    expect(classifyResponse(response(403, "", JSON.stringify({ error: "request_ended" })))).toBe("ended");
    expect(classifyResponse(response(401))).toBe("unauthorised");
    expect(classifyResponse(response(413))).toBe("no-room");
    expect(classifyResponse(response(507))).toBe("no-room");
    for (const status of [408, 429, 500, 502, 503, 504]) expect(classifyResponse(response(status))).toBe("unavailable");
    expect(classifyResponse(response(403, "upload_only"))).toBe("refused");
    expect(classifyResponse(response(400))).toBe("refused");
    expect(classifyResponse(response(404))).toBe("refused");
  });

  it("prefers the header over the body, and ignores a body that is not an error object", () => {
    expect(classifyResponse(response(403, "request_ended", JSON.stringify({ error: "upload_only" })))).toBe("ended");
    expect(classifyResponse(response(403, "", "<html>"))).toBe("refused");
    expect(classifyResponse(response(403, "", JSON.stringify({ error: 7 })))).toBe("refused");
  });

  it("repeats only what might work on its own", () => {
    expect(new UploadError("network").retryable).toBe(true);
    expect(new UploadError("unavailable", 503).retryable).toBe(true);
    for (const failure of ["ended", "no-room", "unauthorised", "refused"] as const) expect(new UploadError(failure).retryable).toBe(false);
  });
});

describe("retrying a cut-off upload", () => {
  const delays = RETRY_DELAYS_MS;

  it("waits 5 s, 15 s then 60 s, each time with a fresh attempt, and then succeeds", async () => {
    expect(delays).toEqual([5_000, 15_000, 60_000]);
    const waits: number[] = [];
    const notices: number[] = [];
    let attempts = 0;
    const result = await withRetries({
      until: NOW + 1_000,
      now: () => NOW,
      wait: (milliseconds) => { waits.push(milliseconds); return Promise.resolve(); },
      onWait: (failed) => notices.push(failed),
      attempt: () => {
        attempts += 1;
        return attempts < 4 ? Promise.reject(new UploadError("network")) : Promise.resolve("sent");
      },
    });
    expect(result).toBe("sent");
    expect(attempts).toBe(4);
    expect(waits).toEqual([5_000, 15_000, 60_000]);
    expect(notices).toEqual([1, 2, 3]);
  });

  it("gives up with the last error once the schedule is spent, so the page can offer Try again", async () => {
    const waits: number[] = [];
    let attempts = 0;
    await expect(withRetries({
      until: NOW + 1_000,
      now: () => NOW,
      wait: (milliseconds) => { waits.push(milliseconds); return Promise.resolve(); },
      attempt: () => {
        attempts += 1;
        return Promise.reject(new UploadError("unavailable", 503));
      },
    })).rejects.toMatchObject({ failure: "unavailable", status: 503 });
    expect(attempts).toBe(4);
    expect(waits).toHaveLength(3);
  });

  it("never repeats a refusal", async () => {
    for (const failure of ["ended", "no-room", "unauthorised", "refused"] as const) {
      const wait = vi.fn(() => Promise.resolve());
      let attempts = 0;
      await expect(withRetries({
        until: NOW + 1_000,
        now: () => NOW,
        wait,
        attempt: () => {
          attempts += 1;
          return Promise.reject(new UploadError(failure));
        },
      })).rejects.toMatchObject({ failure });
      expect(attempts).toBe(1);
      expect(wait).not.toHaveBeenCalled();
    }
  });

  it("stops with ended when the grant runs out between attempts", async () => {
    let clock = NOW;
    let attempts = 0;
    await expect(withRetries({
      until: NOW + 10,
      now: () => clock,
      wait: (milliseconds) => { clock += milliseconds / 1000; return Promise.resolve(); },
      attempt: () => {
        attempts += 1;
        return Promise.reject(new UploadError("network"));
      },
    })).rejects.toMatchObject({ failure: "ended" });
    // The first wait is 5 s, the second pushes the clock to the end of the grant.
    expect(attempts).toBe(2);
  });

  it("does not start at all when the grant has already ended", async () => {
    const attempt = vi.fn(() => Promise.resolve("never"));
    await expect(withRetries({ until: NOW, now: () => NOW, attempt })).rejects.toMatchObject({ failure: "ended" });
    expect(attempt).not.toHaveBeenCalled();
  });

  it("stops at once when the person leaves", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const outcome = withRetries({
      until: NOW + 1_000,
      now: () => NOW,
      signal: controller.signal,
      attempt: () => {
        attempts += 1;
        controller.abort();
        return Promise.reject(new UploadError("network"));
      },
    });
    await expect(outcome).rejects.toBeInstanceOf(UploadError);
    expect(attempts).toBe(1);
  });

  it("sleeps for the time given and wakes early when cancelled", async () => {
    vi.useFakeTimers();
    try {
      const done = vi.fn();
      const pending = sleep(5_000).then(done);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(done).toHaveBeenCalledOnce();

      const controller = new AbortController();
      const cancelled = sleep(60_000, controller.signal);
      controller.abort();
      await expect(cancelled).rejects.toBeDefined();
      await expect(sleep(1, controller.signal)).rejects.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
