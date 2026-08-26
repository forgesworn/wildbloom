import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const HASHED_ASSET = /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(?:css|js)$/u;

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

export function inspectProductionBuild(root = resolve(process.cwd(), "dist")) {
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
  return paths.map((relative) => {
    const absolute = resolve(root, relative);
    const details = regularFile(absolute, `Production file ${relative}`);
    const bytes = readFileSync(absolute);
    return {
      path: relative,
      bytes: details.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}
