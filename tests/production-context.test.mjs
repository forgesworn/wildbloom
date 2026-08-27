import { describe, expect, it } from "vitest";
import { validateProductionContext } from "../scripts/assert-production-context.mjs";

const COMMIT = "a".repeat(40);

function valid(overrides = {}) {
  return {
    sourceCommit: COMMIT,
    checkedOutCommit: COMMIT,
    workflowRef: "refs/heads/main",
    productionOrigin: "https://wildbloom.example",
    ...overrides,
  };
}

describe("production context", () => {
  it("accepts an exact main commit and custom HTTPS origin", () => {
    expect(validateProductionContext(valid())).toEqual({
      sourceCommit: COMMIT,
      origin: "https://wildbloom.example",
    });
  });

  it.each([
    [{ sourceCommit: "main" }, "full lowercase Git commit"],
    [{ checkedOutCommit: "b".repeat(40) }, "does not match"],
    [{ workflowRef: "refs/heads/feature" }, "main workflow ref"],
    [{ productionOrigin: "http://wildbloom.example" }, "requires HTTPS"],
    [{ productionOrigin: "https://127.0.0.1" }, "custom domain"],
    [{ productionOrigin: "https://localhost" }, "custom domain"],
    [{ productionOrigin: "https://forgesworn.github.io" }, "not a preview host"],
    [{ productionOrigin: "https://wildbloom.pages.dev" }, "not a preview host"],
    [{ productionOrigin: "https://wildbloom.pages.dev." }, "not a preview host"],
  ])("rejects an unsafe production context", (overrides, message) => {
    expect(() => validateProductionContext(valid(overrides))).toThrow(message);
  });
});
