// Runs a TypeScript entry point with the staging configuration (.env.staging).
// Usage: node scripts/run-staging.mjs <file.ts> [args...]
// No shell is used, so arguments (e.g. --name "Full Name") are passed through unchanged.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const [file, ...args] = process.argv.slice(2);
if (!file) {
  console.error("usage: node scripts/run-staging.mjs <file.ts> [args...]");
  process.exit(1);
}
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const child = spawn(process.execPath, [tsxCli, file, ...args], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, LBE_ENV_FILE: ".env.staging" },
});
child.on("exit", (code) => process.exit(code ?? 1));
