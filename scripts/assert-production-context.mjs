import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normaliseDeploymentOrigin } from "./verify-deployment.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const PREVIEW_HOST = /(?:\.github\.io|\.pages\.dev)$/u;

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateProductionContext({
  sourceCommit,
  checkedOutCommit,
  workflowRef,
  productionOrigin,
}) {
  expect(FULL_COMMIT.test(sourceCommit), "Production source must be one full lowercase Git commit.");
  expect(FULL_COMMIT.test(checkedOutCommit), "The checked-out source did not resolve to one full lowercase Git commit.");
  expect(sourceCommit === checkedOutCommit, "The requested production source does not match the checked-out commit.");
  expect(workflowRef === "refs/heads/main", "Production release and monitoring must run from the main workflow ref.");
  const origin = normaliseDeploymentOrigin(productionOrigin);
  const hostname = new URL(origin).hostname.toLowerCase().replace(/\.$/u, "");
  const ipCandidate = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  expect(hostname !== "localhost" && isIP(ipCandidate) === 0, "Production origin must use a custom domain.");
  expect(!PREVIEW_HOST.test(hostname), "Production origin must be a reviewed custom domain, not a preview host.");
  return { sourceCommit, origin };
}

function argumentsFrom(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--source-commit", "--workflow-ref", "--origin"].includes(argument)) {
      throw new Error(`Unknown production-context argument: ${argument}`);
    }
    const value = argv[index + 1];
    expect(value && !value.startsWith("--"), `${argument} requires a value.`);
    const key = argument === "--source-commit"
      ? "sourceCommit"
      : argument === "--workflow-ref"
        ? "workflowRef"
        : "productionOrigin";
    expect(options[key] === undefined, `${argument} may be supplied only once.`);
    options[key] = value;
    index += 1;
  }
  expect(options.sourceCommit !== undefined, "--source-commit is required.");
  expect(options.workflowRef !== undefined, "--workflow-ref is required.");
  expect(options.productionOrigin !== undefined, "--origin is required.");
  return options;
}

function run() {
  const options = argumentsFrom(process.argv.slice(2));
  const checkedOutCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const result = validateProductionContext({ ...options, checkedOutCommit });
  process.stdout.write(`Production context accepted ${result.sourceCommit} for ${result.origin}.\n`);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === resolve(fileURLToPath(import.meta.url))) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
