import type { Db } from "./db.ts";

export interface SeedPasswords {
  admin: string;
  approver: string;
  founder: string;
  editor: string;
}

export interface SeedResult {
  users: { admin: string; approver: string; founder: string; editor: string };
  accounts: { company: string; founder: string };
  claims: string[];
}

const oneId = (db: Db) => async (sql: string, params: unknown[]) => {
  const rows = await db.query<{ id: string }>(sql, params);
  return rows[0]!.id;
};

/**
 * Synthetic development data only. No real people, customers or LinkedIn identities.
 * Emails use the reserved `.test` TLD so they can never be delivered.
 */
export async function seed(db: Db, pw: SeedPasswords): Promise<SeedResult> {
  const base = await seedUsersAndAccounts(db, pw);
  return { ...base, claims: await seedSyntheticClaims(db, base.users) };
}

/** Development logins (`.test` emails) and the two DEV accounts with their approvers — no knowledge or claims (P2-05). */
export async function seedUsersAndAccounts(db: Db, pw: SeedPasswords): Promise<Omit<SeedResult, "claims">> {
  const one = oneId(db);
  const user = (email: string, name: string, role: string, password: string) =>
    one("select lbe.admin_create_user($1, $2, $3, $4) as id", [email, name, role, password]);

  const admin = await user("admin@lbe.test", "Dev Admin", "admin", pw.admin);
  const approver = await user("marketing@lbe.test", "Dev Marketing Approver", "approver", pw.approver);
  const founder = await user("founder@lbe.test", "Dev Founder", "approver", pw.founder);
  const editor = await user("editor@lbe.test", "Dev Editor", "editor", pw.editor);

  const company = await one(
    `insert into lbe.social_accounts(kind, display_name, voice_profile, pillars)
     values ('company_page', 'ActTrident (company page) — DEV', 'company',
             array['threat-landscape', 'product-education', 'security-culture', 'company-news'])
     returning id`, []);
  const founderAcct = await one(
    `insert into lbe.social_accounts(kind, display_name, voice_profile, pillars)
     values ('founder_profile', 'Founder profile — DEV', 'founder',
             array['founder-lessons', 'security-leadership', 'industry-commentary'])
     returning id`, []);

  // Separate approval authority: the founder account is approved only by the founder.
  await db.query(
    `insert into lbe.account_approvers(account_id, user_id) values ($1, $2), ($1, $3), ($4, $5)`,
    [company, approver, admin, founderAcct, founder],
  );
  return { users: { admin, approver, founder, editor }, accounts: { company, founder: founderAcct } };
}

/** The [SYNTHETIC] example claims (three verified, one unverified to demonstrate the gate). */
export async function seedSyntheticClaims(db: Db, users: SeedResult["users"]): Promise<string[]> {
  const one = oneId(db);
  const { approver, editor } = users;
  const claimRows: Array<[string, string, string | null, string]> = [
    ["[SYNTHETIC] ActTrident is a UK-registered cybersecurity company.", "company_fact", null,
      "Synthetic development claim — replace with Companies House evidence."],
    ["[SYNTHETIC] ActTrident's platform maps findings to the MITRE ATT&CK framework.", "product_capability", null,
      "Synthetic development claim — replace with product documentation link."],
    ["[SYNTHETIC] Phishing remains a common initial access vector reported by UK organisations.", "breach_statistic",
      "https://www.gov.uk/government/collections/cyber-security-breaches-survey",
      "Synthetic wording; owner must confirm the exact figure and survey year before use."],
  ];
  const claims: string[] = [];
  for (const [statement, category, url, note] of claimRows) {
    const id = await one(
      `insert into lbe.claims(statement, category, evidence_url, evidence_note, created_by)
       values ($1, $2, $3, $4, $5) returning id`, [statement, category, url, note, editor]);
    await db.query(
      `update lbe.claims set status = 'verified', verified_by = $2, verified_at = now() where id = $1`, [id, approver]);
    claims.push(id);
  }
  // One unverified claim to demonstrate the gate.
  claims.push(await one(
    `insert into lbe.claims(statement, category, evidence_note, created_by)
     values ('[SYNTHETIC] ActTrident blocks 99% of ransomware.', 'security_effectiveness',
             'UNVERIFIED example — must never be published without evidence.', $1) returning id`, [editor]));
  return claims;
}
