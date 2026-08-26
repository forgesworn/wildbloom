import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function privateRecordOutput(path, label, buildRoot = resolve(process.cwd(), "dist")) {
  const requested = resolve(path);
  const output = resolve(realpathSync(dirname(requested)), basename(requested));
  const canonicalBuildRoot = realpathSync(buildRoot);
  const fromBuildRoot = relative(canonicalBuildRoot, output);
  if (
    fromBuildRoot === ""
    || (fromBuildRoot !== ".." && !fromBuildRoot.startsWith(`..${sep}`) && !isAbsolute(fromBuildRoot))
  ) {
    throw new Error(`${label} must not be written into the public build directory.`);
  }
  return output;
}
