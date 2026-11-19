// Lightweight secret scan over files tracked or staged in git. Exit code 1 on findings.
// (gitleaks is the recommended full scanner; see docs/setup.md.)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split("\n").filter(Boolean)
  .filter((f) => !f.endsWith("package-lock.json") && !/\.(png|jpg|ico|woff2?)$/.test(f));

const RULES = [
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["Private key", /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["LinkedIn session cookie", /li_at=[A-Za-z0-9_-]{20,}/],
  ["Bearer token literal", /Bearer [A-Za-z0-9._-]{40,}/],
  ["Postgres URL with password", /postgres(ql)?:\/\/[^:\s/]+:(?!<password>)[^@\s]{6,}@/],
  // `<placeholder>` values in documentation are allowed.
  ["Filled dev password in example", /^LBE_DEV_[A-Z]+_PASSWORD=(?!<)\S+/m],
  ["Filled API key in example", /^ANTHROPIC_API_KEY=(?!<)\S+/m],
];

const findings = [];
for (const f of files) {
  if (f === ".env" || f.startsWith(".env.") && f !== ".env.example") {
    findings.push(`${f}: environment file is tracked by git`);
    continue;
  }
  let text;
  try { text = readFileSync(path.join(root, f), "utf8"); } catch { continue; }
  for (const [name, re] of RULES) {
    if (f === "scripts/secret-scan.mjs") continue;
    if (re.test(text)) findings.push(`${f}: ${name}`);
  }
}
if (findings.length) {
  console.error("Possible secrets found:\n  " + findings.join("\n  "));
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} files checked).`);
