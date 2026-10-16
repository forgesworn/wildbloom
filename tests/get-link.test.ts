import { describe, expect, it } from "vitest";
import { classifyLinkFailure } from "../src/get/link.js";

function fragment(expires: unknown): string {
  const json = JSON.stringify({ v: "foregather-public-handoff/1", room: { session: { expires }, secret_format: "words" } });
  return `#${Buffer.from(json).toString("base64url")}`;
}

describe("link failure classification", () => {
  it("calls an empty fragment missing", () => {
    expect(classifyLinkFailure("", 1_000)).toBe("missing");
    expect(classifyLinkFailure("#", 1_000)).toBe("missing");
  });

  it("calls a link whose public expiry has passed expired, without any network", () => {
    expect(classifyLinkFailure(fragment(999), 1_000)).toBe("expired");
    expect(classifyLinkFailure(fragment(1_000), 1_000)).toBe("expired");
  });

  it("calls everything else incomplete", () => {
    expect(classifyLinkFailure(fragment(5_000), 1_000)).toBe("invalid");
    expect(classifyLinkFailure(fragment("soon"), 1_000)).toBe("invalid");
    expect(classifyLinkFailure("#not*base64", 1_000)).toBe("invalid");
    expect(classifyLinkFailure(`#${Buffer.from("plain text").toString("base64url")}`, 1_000)).toBe("invalid");
    expect(classifyLinkFailure(`#${"A".repeat(1_401)}`, 1_000)).toBe("invalid");
  });
});
