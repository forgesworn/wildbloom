import { globSync, readFileSync } from "node:fs";

const EXPECTED_NPM_CONFIG = Object.freeze({
  audit: "true",
  "engine-strict": "true",
  fund: "false",
  "ignore-scripts": "true",
  "save-exact": "true",
  "strict-peer-deps": "true",
});
const EXPECTED_NPM_ENGINE = ">=11 <12";
const EXPECTED_NPM_MAJOR = 11;
const EXPECTED_NODE_VERSION = "24.19.0";
const EXPECTED_INSTALL_COMMAND = "npm ci --ignore-scripts";
const EXPECTED_WORKFLOW_INSTALLS = 10;
const EXPECTED_WRANGLER_VERSION = "4.127.0";
const REVIEWED_WORKFLOW_ACTIONS = Object.freeze({
  "actions/checkout": "3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/download-artifact": "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  "actions/configure-pages": "983d7736d9b0ae728b81ab479565c72886d7745b",
  "actions/deploy-pages": "d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e",
  "actions/setup-node": "820762786026740c76f36085b0efc47a31fe5020",
  "actions/upload-artifact": "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "actions/upload-pages-artifact": "7b1f4a764d45c48632c6b24a0339c27f5614fb0b",
});

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
if (packageJson.engines?.npm !== EXPECTED_NPM_ENGINE) {
  fail(`package.json must require npm ${EXPECTED_NPM_ENGINE}.`);
}
if (packageJson.devDependencies?.wrangler !== EXPECTED_WRANGLER_VERSION) {
  fail(`package.json must pin wrangler ${EXPECTED_WRANGLER_VERSION}.`);
}
if (readFileSync(".nvmrc", "utf8") !== `${EXPECTED_NODE_VERSION}\n`) {
  fail(`.nvmrc must pin the canonical build to Node ${EXPECTED_NODE_VERSION}.`);
}
if (readFileSync(".gitattributes", "utf8") !== "* text=auto eol=lf\n") {
  fail(".gitattributes must normalise every text checkout to LF.");
}
const userAgent = process.env.npm_config_user_agent ?? "";
const runningNpm = /^npm\/([^\s]+)/u.exec(userAgent)?.[1];
if (runningNpm && Number(runningNpm.split(".", 1)[0]) !== EXPECTED_NPM_MAJOR) {
  fail(`expected npm ${EXPECTED_NPM_MAJOR}.x, received npm@${runningNpm}.`);
}

const workflowFiles = globSync(".github/workflows/*.yml").sort();
let installCommands = 0;
let actionUses = 0;
const observedActions = new Set();
for (const workflow of workflowFiles) {
  const source = readFileSync(workflow, "utf8");
  const setupNodeBlocks = source.split("actions/setup-node@").slice(1);
  for (const block of setupNodeBlocks) {
    const step = block.split(/^\s*-\s+(?:uses|name|run):/mu, 1)[0];
    if (!/^\s+node-version-file:\s+\.nvmrc\s*$/mu.test(step) || /^\s+node-version:/mu.test(step)) {
      fail(`${workflow} must consume the exact .nvmrc build version in every setup-node step.`);
    }
  }
  const installLines = source.split(/\r?\n/u).filter((line) => /\bnpm\s+(?:ci|i|install)\b/u.test(line));
  for (const line of installLines) {
    installCommands += 1;
    const match = /^\s*-\s+run:\s+([^#]+?)(?:\s+#.*)?$/u.exec(line);
    if (match?.[1]?.trim() !== EXPECTED_INSTALL_COMMAND) {
      fail(`${workflow} must use ${EXPECTED_INSTALL_COMMAND}.`);
    }
  }
  const actionLines = source.split(/\r?\n/u).filter((line) => /^\s+(?:-\s+)?uses:/u.test(line));
  for (const line of actionLines) {
    actionUses += 1;
    const match = /^\s+(?:-\s+)?uses:\s+([a-z0-9_.-]+\/[a-z0-9_.-]+)@([0-9a-f]{40})(?:\s+#\s+v[0-9]+\.[0-9]+\.[0-9]+)?\s*$/iu.exec(line);
    if (!match) fail(`${workflow} must pin every workflow action to one full reviewed commit.`);
    const [, action, commit] = match;
    if (REVIEWED_WORKFLOW_ACTIONS[action] !== commit) {
      fail(`${workflow} uses an unreviewed workflow action revision: ${action}@${commit}.`);
    }
    observedActions.add(action);
  }
}
if (installCommands !== EXPECTED_WORKFLOW_INSTALLS) {
  fail(`expected ${EXPECTED_WORKFLOW_INSTALLS} reviewed workflow installs, found ${installCommands}.`);
}
for (const action of Object.keys(REVIEWED_WORKFLOW_ACTIONS)) {
  if (!observedActions.has(action)) fail(`reviewed workflow action is no longer used: ${action}.`);
}

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
if (lock.packages?.["node_modules/wrangler"]?.version !== EXPECTED_WRANGLER_VERSION) {
  fail(`package-lock.json must pin wrangler ${EXPECTED_WRANGLER_VERSION}.`);
}
const scriptedPackages = Object.entries(lock.packages ?? {})
  .filter(([, entry]) => entry?.hasInstallScript)
  .map(([path, entry]) => `${path.replace(/^node_modules\//u, "")}@${entry.version ?? "unknown"}`)
  .sort();

process.stdout.write(
  `Install policy passed: ${installCommands} workflow installs disable lifecycle scripts; `
  + `${actionUses} workflow action uses match ${observedActions.size} reviewed full-commit pins; `
  + `${scriptedPackages.length} locked packages with install hooks remain inert (${scriptedPackages.join(", ")}).\n`,
);
