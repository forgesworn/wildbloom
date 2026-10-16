import { describe, expect, it } from "vitest";
import { BlossomRetrievalError } from "../src/core/blossom.js";
import { classifyDownloadFailure, classifyPairingFailure } from "../src/get/failure.js";

function transport(kind: string, status?: number): Error {
  return Object.assign(new Error(kind), { name: "ForegatherTransportError", kind, ...(status === undefined ? {} : { status }) });
}

describe("pairing failure classification", () => {
  it("treats a refused claim as an already used link", () => {
    for (const status of [403, 404, 409, 410]) expect(classifyPairingFailure(transport("http", status), false)).toBe("claim-refused");
  });

  it("does not call a later 404 a refused claim", () => {
    expect(classifyPairingFailure(transport("http", 404), true)).toBe("network");
  });

  it("maps timeouts, server errors and fetch failures to a connection problem", () => {
    expect(classifyPairingFailure(transport("timeout"), false)).toBe("network");
    expect(classifyPairingFailure(transport("http", 503), false)).toBe("network");
    expect(classifyPairingFailure(new TypeError("Failed to fetch"), true)).toBe("network");
    expect(classifyPairingFailure(new DOMException("slow", "TimeoutError"), true)).toBe("network");
  });

  it("maps expiry and cancellation straight through", () => {
    expect(classifyPairingFailure(transport("expired"), true)).toBe("expired");
    expect(classifyPairingFailure(transport("cancelled"), true)).toBe("cancelled");
  });

  it("reads the kit's plain string rejection after a claim as wrong words", () => {
    expect(classifyPairingFailure("Invalid invitation", true)).toBe("wrong-words");
    expect(classifyPairingFailure(new Error("anything"), true)).toBe("wrong-words");
    expect(classifyPairingFailure("Invalid invitation", false)).toBe("network");
  });
});

describe("download failure classification", () => {
  it("separates a missing object, an unreachable server and damaged bytes", () => {
    expect(classifyDownloadFailure(new BlossomRetrievalError("x", "http", 404), "fetch")).toBe("missing");
    expect(classifyDownloadFailure(new BlossomRetrievalError("x", "http", 410), "fetch")).toBe("missing");
    expect(classifyDownloadFailure(new BlossomRetrievalError("x", "http", 500), "fetch")).toBe("unavailable");
    expect(classifyDownloadFailure(new TypeError("Failed to fetch"), "fetch")).toBe("unavailable");
    expect(classifyDownloadFailure(new Error("Blossom retrieval timed out."), "fetch")).toBe("unavailable");
    expect(classifyDownloadFailure(new BlossomRetrievalError("x", "integrity"), "fetch")).toBe("damaged");
    expect(classifyDownloadFailure(new Error("The recovery key is wrong or the encrypted envelope was modified."), "open")).toBe("damaged");
  });
});
