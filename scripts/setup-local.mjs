// Creates a local .env from .env.example with random development passwords.
// Never overwrites an existing .env.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, ".env");
if (existsSync(target)) {
  console.log(".env already exists — left unchanged.");
  process.exit(0);
}
const pw = () => randomBytes(18).toString("base64url");
let text = readFileSync(path.join(root, ".env.example"), "utf8");
for (const key of ["LBE_PG_PASSWORD", "LBE_DEV_ADMIN_PASSWORD", "LBE_DEV_APPROVER_PASSWORD", "LBE_DEV_FOUNDER_PASSWORD", "LBE_DEV_EDITOR_PASSWORD"]) {
  text = text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${pw()}`);
}
writeFileSync(target, text, { encoding: "utf8", flag: "wx" });
console.log("Created .env with random development passwords.");
console.log("Next: npm run db:seed   (then sign in with the emails it prints and the passwords in .env)");
