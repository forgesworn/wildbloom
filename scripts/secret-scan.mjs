import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const patterns = [
  ["Nostr secret key", /\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{20,}\b/giu],
  ["GitHub token", /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu],
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu],
];

let files;
try {
  files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
} catch {
  files = [];
}

const findings = [];
for (const file of files) {
  if (file === "scripts/secret-scan.mjs" || file === "package-lock.json") continue;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`${file}: ${label}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`Secret scan failed:\n${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Secret scan passed (${files.length} files inspected).\n`);
