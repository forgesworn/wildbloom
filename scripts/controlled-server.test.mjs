import { once } from "node:events";
import { createServer, get } from "node:http";
import { expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { closeControlledServer } from "./controlled-server.mjs";

test("denying a controlled HTTP server closes an unfinished response", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Length": "100" });
    response.write("partial");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const request = get(`http://127.0.0.1:${server.address().port}`);
  const [response] = await once(request, "response");
  response.on("error", () => undefined);
  const closed = new Promise((resolve) => response.once("close", resolve));
  response.resume();
  try {
    await closeControlledServer(server);
    await closed;
    expect(response.complete).toBe(false);
    expect(server.listening).toBe(false);
  } finally {
    request.destroy();
    server.closeAllConnections();
    server.close();
  }
}, 2_000);

test("relay cleanup terminates a client that has not closed its WebSocket", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  await once(client, "open");
  const closed = once(client, "close");
  try {
    expect(server.clients.size).toBe(1);
    await closeControlledServer(server);
    await closed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
  } finally {
    client.terminate();
    for (const socket of server.clients) socket.terminate();
    server.close();
  }
}, 2_000);
