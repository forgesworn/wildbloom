import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const HASHED_ASSET = /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:css|js)$/u;
export const MAX_PRODUCTION_FILES = 64;
export const MAX_PRODUCTION_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_PRODUCTION_BUILD_BYTES = 64 * 1024 * 1024;

export function isProductionAssetPath(relative) {
  return HASHED_ASSET.test(relative);
}

function regularFile(path, label) {
  let details;
  try {
    details = lstatSync(path);
  } catch {
    throw new Error(`${label} is missing.`);
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a directory or symbolic link.`);
  }
  return details;
}

export function loadProductionBuild(root = resolve(process.cwd(), "dist")) {
  let rootDetails;
  try {
    rootDetails = lstatSync(root);
  } catch {
    throw new Error(`Production build directory is missing: ${root}`);
  }
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error("Production build root must be a real directory.");
  }

  const rootEntries = readdirSync(root, { withFileTypes: true });
  const unexpectedRootEntries = rootEntries
    .map((entry) => entry.name)
    .filter((name) => name !== "assets" && name !== "index.html");
  if (unexpectedRootEntries.length > 0) {
    throw new Error(`Production build contains unexpected root entries: ${unexpectedRootEntries.sort().join(", ")}`);
  }

  regularFile(resolve(root, "index.html"), "Production index.html");
  const assetsPath = resolve(root, "assets");
  let assetDirectory;
  try {
    assetDirectory = lstatSync(assetsPath);
  } catch {
    throw new Error("Production assets directory is missing.");
  }
  if (!assetDirectory.isDirectory() || assetDirectory.isSymbolicLink()) {
    throw new Error("Production assets path must be a real directory.");
  }

  const assetEntries = readdirSync(assetsPath, { withFileTypes: true });
  if (assetEntries.length === 0) throw new Error("Production build contains no assets.");
  for (const entry of assetEntries) {
    const relative = `assets/${entry.name}`;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Production asset must be a regular file: ${relative}`);
    }
    if (!isProductionAssetPath(relative)) {
      throw new Error(`Production asset is not a hashed JavaScript or CSS file: ${relative}`);
    }
  }

  const paths = ["index.html", ...assetEntries.map((entry) => `assets/${entry.name}`)].sort();
  if (paths.length > MAX_PRODUCTION_FILES) {
    throw new Error(`Production build contains more than ${MAX_PRODUCTION_FILES} files.`);
  }
  let buildBytes = 0;
  return paths.map((relative) => {
    const absolute = resolve(root, relative);
    const before = regularFile(absolute, `Production file ${relative}`);
    if (before.size === 0) throw new Error(`Production file must not be empty: ${relative}`);
    if (before.size > MAX_PRODUCTION_FILE_BYTES) {
      throw new Error(`Production file exceeds the ${MAX_PRODUCTION_FILE_BYTES}-byte limit: ${relative}`);
    }
    buildBytes += before.size;
    if (buildBytes > MAX_PRODUCTION_BUILD_BYTES) {
      throw new Error(`Production build exceeds the ${MAX_PRODUCTION_BUILD_BYTES}-byte limit.`);
    }
    const content = readFileSync(absolute);
    const after = regularFile(absolute, `Production file ${relative}`);
    if (
      content.length !== before.size
      || after.size !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`Production file changed while it was being inspected: ${relative}`);
    }
    return {
      path: relative,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
    };
  });
}

export function inspectProductionBuild(root = resolve(process.cwd(), "dist")) {
  return loadProductionBuild(root).map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
}
