// Usage: npm run user:create -- --email someone@example.com --name "Full Name" --role approver [--approver-for <account-id>]
// The password is read from the LBE_NEW_USER_PASSWORD environment variable so it never appears in shell history.
import { parseArgs } from "node:util";
import { ROLES } from "@lbe/domain";
import { loadConfig } from "../config.ts";
import { openConfiguredDb } from "../runtime.ts";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
    role: { type: "string" },
    "approver-for": { type: "string", multiple: true },
  },
});
const password = process.env.LBE_NEW_USER_PASSWORD ?? "";
if (!values.email || !values.name || !values.role || !(ROLES as readonly string[]).includes(values.role)) {
  console.error(`Required: --email, --name, --role (${ROLES.join("|")}). Password via LBE_NEW_USER_PASSWORD.`);
  process.exit(1);
}
if (password.length < 12) {
  console.error("Set LBE_NEW_USER_PASSWORD (12+ characters) before running this command.");
  process.exit(1);
}
const db = await openConfiguredDb(loadConfig());
const rows = await db.query<{ id: string }>("select lbe.admin_create_user($1, $2, $3, $4) as id",
  [values.email, values.name, values.role, password]);
const id = rows[0]!.id;
for (const accountId of values["approver-for"] ?? []) {
  await db.query("insert into lbe.account_approvers(account_id, user_id) values ($1, $2)", [accountId, id]);
}
console.log(`Created user ${values.email} (${values.role}) id=${id}`);
await db.close();
