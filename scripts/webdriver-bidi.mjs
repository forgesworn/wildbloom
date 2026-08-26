import WebSocket from "ws";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

function timeoutAfter(milliseconds, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref?.();
  });
}

export class WebDriverBiDi {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #events = new Set();

  static async connect(url, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    const socket = new WebSocket(url, { handshakeTimeout: timeoutMs });
    await Promise.race([
      new Promise((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      }),
      timeoutAfter(timeoutMs, `WebDriver BiDi did not open ${url}.`),
    ]);
    return new WebDriverBiDi(socket);
  }

  constructor(socket) {
    this.#socket = socket;
    socket.on("message", (data) => this.#receive(data));
    socket.on("error", (error) => this.#rejectPending(error));
    socket.on("close", () => this.#rejectPending(new Error("WebDriver BiDi connection closed.")));
  }

  #receive(data) {
    let message;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      this.#rejectPending(new Error("WebDriver BiDi returned malformed JSON."));
      return;
    }
    if (message.type === "event") {
      for (const listener of this.#events) listener(message);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.type === "success") pending.resolve(message.result);
    else pending.reject(new Error(`WebDriver BiDi ${message.error ?? "command"} error: ${message.message ?? "unknown failure"}`));
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  onEvent(listener) {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  command(method, params = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    if (this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("WebDriver BiDi is not open."));
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`WebDriver BiDi ${method} timed out.`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async evaluateJson(context, expression, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    const outcome = await this.command("script.evaluate", {
      expression: `(async () => JSON.stringify(await (${expression})))()`,
      target: { context },
      awaitPromise: true,
      resultOwnership: "none",
    }, timeoutMs);
    if (outcome.type !== "success") {
      const detail = outcome.exceptionDetails?.text ?? outcome.exceptionDetails?.exception?.value ?? "unknown script exception";
      throw new Error(`Tor Browser script failed: ${detail}`);
    }
    if (outcome.result?.type !== "string") throw new Error("Tor Browser script returned a non-JSON result.");
    return JSON.parse(outcome.result.value);
  }

  async close() {
    if (this.#socket.readyState !== WebSocket.OPEN) return;
    await this.command("session.end").catch(() => undefined);
    this.#socket.close();
  }
}
