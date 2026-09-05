/** Stop a disposable acceptance server, including active HTTP or WebSocket clients. */
export function closeControlledServer(server) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Controlled server did not close within five seconds.")), 5_000);
    server.close((error) => {
      clearTimeout(timer);
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
    // HTTP close waits for active responses; WebSocket close waits for clients.
    // Neither is appropriate when simulating denial or tearing down a fixture.
    server.closeAllConnections?.();
    for (const client of server.clients ?? []) client.terminate();
  });
}
