import { globSync, readFileSync } from "node:fs";

const EXPECTED_NPM_CONFIG = Object.freeze({
  audit: "true",
  "engine-strict": "true",
  fund: "false",
  "ignore-scripts": "true",
  "save-exact": "true",
  "strict-peer-deps": "true",
});
const EXPECTED_PACKAGE_MANAGER = "npm@11.11.0";
const EXPECTED_INSTALL_COMMAND = "npm ci --ignore-scripts";
const EXPECTED_WORKFLOW_INSTALLS = 7;

function fail(message) {
  process.stderr.write(`Install policy failed: ${message}\n`);
  process.exit(1);
}

const npmConfig = new Map();
for (const rawLine of readFileSync(".npmrc", "utf8").split(/\r?\n/u)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#") || line.startsWith(";")) continue;
  const separator = line.indexOf("=");
  if (separator <= 0) fail(`invalid .npmrc entry ${JSON.stringify(line)}.`);
  const key = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  if (npmConfig.has(key)) fail(`duplicate .npmrc entry ${key}.`);
  npmConfig.set(key, value);
}

if (npmConfig.size !== Object.keys(EXPECTED_NPM_CONFIG).length) {
  fail(".npmrc must contain only the reviewed install controls.");
}
for (const [key, value] of Object.entries(EXPECTED_NPM_CONFIG)) {
  if (npmConfig.get(key) !== value) fail(`.npmrc must set ${key}=${value}.`);
}

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (packageJson.packageManager !== EXPECTED_PACKAGE_MANAGER) {
  fail(`package.json must pin ${EXPECTED_PACKAGE_MANAGER}.`);
}
const userAgent = process.env.npm_config_user_agent ?? "";
const runningNpm = /^npm\/([^\s]+)/u.exec(userAgent)?.[1];
if (runningNpm && `npm@${runningNpm}` !== EXPECTED_PACKAGE_MANAGER) {
  fail(`expected ${EXPECTED_PACKAGE_MANAGER}, received npm@${runningNpm}.`);
}

const workflowFiles = globSync(".github/workflows/*.yml").sort();
let installCommands = 0;
for (const workflow of workflowFiles) {
  const source = readFileSync(workflow, "utf8");
  const installLines = source.split(/\r?\n/u).filter((line) => /\bnpm\s+(?:ci|i|install)\b/u.test(line));
  for (const line of installLines) {
    installCommands += 1;
    const match = /^\s*-\s+run:\s+([^#]+?)(?:\s+#.*)?$/u.exec(line);
    if (match?.[1]?.trim() !== EXPECTED_INSTALL_COMMAND) {
      fail(`${workflow} must use ${EXPECTED_INSTALL_COMMAND}.`);
    }
  }
}
if (installCommands !== EXPECTED_WORKFLOW_INSTALLS) {
  fail(`expected ${EXPECTED_WORKFLOW_INSTALLS} reviewed workflow installs, found ${installCommands}.`);
}

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const scriptedPackages = Object.entries(lock.packages ?? {})
  .filter(([, entry]) => entry?.hasInstallScript)
  .map(([path, entry]) => `${path.replace(/^node_modules\//u, "")}@${entry.version ?? "unknown"}`)
  .sort();

process.stdout.write(
  `Install policy passed: ${installCommands} workflow installs disable lifecycle scripts; `
  + `${scriptedPackages.length} locked packages with install hooks remain inert (${scriptedPackages.join(", ")}).\n`,
);
