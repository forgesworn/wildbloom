import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { parseArguments, runPreflight } from "./checkout-preflight.mjs";

const args = ["--node", "https://storage.example", "--app", "https://app.example", "--offer", "small", "--rail", "lightning", "--max-sats", "10", "--output", "/tmp/preflight.json"];
const options = parseArguments(args);
const document = () => ({
  version: 1, node_origin: `${options.node}/`, network: "bitcoin", rails: ["lightning"],
  offers: [{ id: "small", price_msat: 10000, capacity_bytes: 1048576,
    delivery_policy: "Operator-managed", retention_policy: "One hour", refund_policy: "Contact operator" }],
});
const cors = {
  "access-control-allow-origin": options.app,
  "access-control-allow-methods": "GET, POST",
  "access-control-allow-headers": "authorization,content-type",
};
function fake({ doc = document(), getHeaders = {}, optionHeaders = {}, status = 200, body } = {}) {
  const calls = [];
  return { calls, fetcher: async (url, request) => {
    calls.push({ url, request });
    assert.equal(request.redirect, "error");
    assert.equal(request.credentials, "omit");
    assert.equal(request.headers.Authorization, undefined);
    assert.equal(request.body, undefined);
    return request.method === "GET"
      ? new Response(body ?? JSON.stringify(doc), { status, headers: { ...cors, "content-type": "application/json", "cache-control": "no-store", ...getHeaders } })
      : new Response(null, { status: 204, headers: { ...cors, ...optionHeaders } });
  } };
}

test("only public reads; report omits endpoints and remote strings", async () => {
  const transport = fake();
  const report = await runPreflight(options, transport.fetcher);
  assert.deepEqual(transport.calls.map((c) => [c.url, c.request.method]), [
    ["https://storage.example/checkout/v1/offers", "GET"],
    ["https://storage.example/checkout/v1/orders", "OPTIONS"],
  ]);
  assert.equal(report.status, "preflight-passed");
  assert.equal(report.livePaymentAccepted, false);
  assert.equal(report.paymentAttempted, false);
  assert.equal(report.priceSats, 10);
  assert.ok(!JSON.stringify(report).includes(".example"));
  assert.ok(!JSON.stringify(report).includes("Contact operator"));
});

test("rejects unsafe/ambiguous command arguments before I/O", () => {
  for (const node of ["http://storage.example", "https://user:password@storage.example", "https://storage.example/path", "https://storage.example/?note=secret", "https://storage.example/#secret", "https://abc.onion"]) {
    assert.throws(() => parseArguments(args.map((v, i) => i === 1 ? node : v)));
  }
  for (const ceiling of ["0", "-1", "1.5", "1e3", "9007199254740991"]) {
    assert.throws(() => parseArguments(args.map((v, i) => i === 9 ? ceiling : v)));
  }
  assert.throws(() => parseArguments([...args, "--node", "https://another.example"]));
  assert.throws(() => parseArguments([...args, "--unknown", "value"]));
  assert.throws(() => parseArguments(args.slice(0, -1)));
  const local = args.map((v, i) => i === 1 ? "http://127.0.0.1:8080" : v);
  assert.throws(() => parseArguments(local));
  assert.equal(parseArguments([...local, "--allow-loopback-http"]).node, "http://127.0.0.1:8080");
});

test("refuses price, rail, origin, policy and response failures", async () => {
  const cases = [
    { doc: { ...document(), node_origin: "https://another.example/" } },
    { doc: { ...document(), network: "regtest" } },
    { doc: { ...document(), rails: ["lnurlcash"] } },
    { doc: { ...document(), offers: [] } },
    { doc: { ...document(), offers: [...document().offers, ...document().offers] } },
    ...[11000, 10001, 0, -1000, Number.MAX_SAFE_INTEGER + 1].map((price_msat) => ({ doc: { ...document(), offers: [{ ...document().offers[0], price_msat }] } })),
    { doc: { ...document(), offers: [{ ...document().offers[0], refund_policy: "" }] } },
    { getHeaders: { "access-control-allow-origin": "*" } },
    { getHeaders: { "cache-control": "public" } },
    { getHeaders: { "content-type": "text/html" } },
    { status: 302 }, { status: 503 }, { body: "not JSON" }, { body: "x".repeat(65537) },
    { optionHeaders: { "access-control-allow-origin": "https://another.example" } },
    { optionHeaders: { "access-control-allow-headers": "content-type" } },
    { optionHeaders: { "access-control-allow-methods": "GET" } },
  ];
  for (const configuration of cases) {
    await assert.rejects(runPreflight(options, fake(configuration).fetcher));
  }
});

test("real loopback HTTP, redirect refusal and bounded streaming", async (t) => {
  const calls = [];
  let mode = "pass";
  const server = createServer((request, response) => {
    calls.push(request.method);
    if (mode === "redirect") {
      response.writeHead(302, { location: "/must-not-follow" });
      response.end();
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors); response.end(); return;
    }
    response.writeHead(200, { ...cors, "cache-control": "no-store", "content-type": "application/json" });
    if (mode === "oversized") {
      response.write("x".repeat(32768)); response.end("x".repeat(32769)); return;
    }
    response.end(JSON.stringify({ ...document(), node_origin: `http://127.0.0.1:${server.address().port}/` }));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const local = { ...options, node: `http://127.0.0.1:${server.address().port}` };
  assert.equal((await runPreflight(local)).status, "preflight-passed");
  assert.deepEqual(calls, ["GET", "OPTIONS"]);
  mode = "redirect";
  await assert.rejects(runPreflight(local));
  assert.equal(calls.length, 3, "redirect target must not receive a request");
  mode = "oversized";
  await assert.rejects(runPreflight(local), /64 KiB/u);
});
