import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  inspectProductionBuild,
  loadProductionBuild,
  MAX_PRODUCTION_BUILD_BYTES,
  MAX_PRODUCTION_FILE_BYTES,
  MAX_PRODUCTION_FILES,
} from "../scripts/production-build.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "wildbloom-production-build-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "index-v1");
  writeFileSync(join(root, "assets", "app-abcdefgh.js"), "app-v1");
  return root;
}

describe("production build snapshot", () => {
  it("loads exact bytes once and returns content-free release metadata", () => {
    const root = buildFixture();
    try {
      const loaded = loadProductionBuild(root);
      const files = new Map(loaded.map((file) => [file.path, file]));
      expect(files.get("index.html")?.content).toEqual(Buffer.from("index-v1"));
      expect(files.get("assets/app-abcdefgh.js")?.content).toEqual(Buffer.from("app-v1"));

      writeFileSync(join(root, "index.html"), "index-v2");
      writeFileSync(join(root, "assets", "app-abcdefgh.js"), "app-v2");
      expect(files.get("index.html")?.content).toEqual(Buffer.from("index-v1"));
      expect(files.get("assets/app-abcdefgh.js")?.content).toEqual(Buffer.from("app-v1"));

      const inspected = inspectProductionBuild(root);
      expect(inspected.find((file) => file.path === "index.html")).toEqual({
        path: "index.html",
        bytes: 8,
        sha256: sha256("index-v2"),
      });
      expect(inspected.every((file) => !Object.hasOwn(file, "content"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects empty and oversized release files before reading them", () => {
    const emptyRoot = buildFixture();
    const oversizedRoot = buildFixture();
    try {
      writeFileSync(join(emptyRoot, "index.html"), "");
      expect(() => loadProductionBuild(emptyRoot)).toThrow(/must not be empty/u);

      truncateSync(join(oversizedRoot, "assets", "app-abcdefgh.js"), MAX_PRODUCTION_FILE_BYTES + 1);
      expect(() => loadProductionBuild(oversizedRoot)).toThrow(new RegExp(`${MAX_PRODUCTION_FILE_BYTES}-byte limit`, "u"));
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
      rmSync(oversizedRoot, { recursive: true, force: true });
    }
  });

  it("rejects release directories with more than the bounded file count", () => {
    const root = buildFixture();
    try {
      for (let index = 0; index < MAX_PRODUCTION_FILES - 1; index += 1) {
        writeFileSync(join(root, "assets", `chunk-${String(index).padStart(8, "0")}.js`), "x");
      }
      expect(() => loadProductionBuild(root)).toThrow(new RegExp(`more than ${MAX_PRODUCTION_FILES} files`, "u"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a release whose individually bounded files exceed the total budget", () => {
    const root = buildFixture();
    const partBytes = Math.floor(MAX_PRODUCTION_BUILD_BYTES / 3) + 1;
    try {
      truncateSync(join(root, "assets", "app-abcdefgh.js"), partBytes);
      for (const name of ["part-bcdefghi.js", "part-cdefghij.js"]) {
        const path = join(root, "assets", name);
        writeFileSync(path, "x");
        truncateSync(path, partBytes);
      }
      expect(() => loadProductionBuild(root)).toThrow(new RegExp(`${MAX_PRODUCTION_BUILD_BYTES}-byte limit`, "u"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
