// Privilege snapshot: any new grant, definer function or table privilege must be reviewed and added here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb, type TestDb } from "../helpers/db.ts";

let t: TestDb;
beforeAll(async () => { t = await freshDb(); });
afterAll(async () => t.db.close());

const executable = async (role: string) => (await t.db.query<{ proname: string }>(
  `select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'lbe' and has_function_privilege($1, p.oid, 'execute') order by 1`, [role])).map((r) => r.proname);

const AGENT = ["attach_media", "brain_load", "brain_propose", "connector_brain_get", "create_content", "learning_inputs", "record_agent_run", "research_record",
  "set_agent_metadata", "set_draft_output", "strategy_save", "submit_for_review", "whoami", "workflow_create", "workflow_finish", "workflow_get"];
const WORKER = ["claim_outbox", "complete_outbox", "expire_credentials", "expire_stale_dispatches", "is_stopped",
  "job_claim", "job_finish", "job_heartbeat", "job_recover_expired", "worker_auto_stop",
  "worker_get_credential", "worker_mark_credential"];
const API = ["admin_add_user", "admin_end_sessions", "admin_list_users", "admin_reset_password", "admin_set_approver",
  "admin_update_user", "attach_media", "begin_oauth", "brain_decide_proposal", "change_password", "brain_list_proposals", "brain_load", "brain_propose", "brain_retire_entry",
  "brain_upsert_entry", "campaign_cancel", "campaign_create", "campaign_get", "campaign_list", "cancel_publication", "connector_create", "connector_revoke_all", "connector_status", "consume_oauth_state", "content_history", "create_claim", "create_content", "decide_content",
  "enqueue_publication", "is_stopped", "job_cancel", "job_enqueue", "job_get", "job_list", "job_resume", "job_retry", "learning_inputs", "login", "media_get", "media_list", "logout", "logout_all", "reconcile_publication", "record_agent_run",
  "release_publication", "research_list", "research_record", "research_review", "research_to_claim", "revoke_linkedin_credential",
  "set_agent_metadata", "set_claim_status", "set_draft_output", "set_account_display_name", "set_account_pillars", "set_live_publishing", "set_media_alt_text", "set_stop", "store_linkedin_credential",
  "strategy_save", "submit_for_review", "update_content", "whoami", "workflow_create", "workflow_finish", "workflow_get",
  "workflow_list", "write_app_audit"];

describe("function execute privileges match the reviewed allowlists", () => {
  it("lbe_agent", async () => { expect(await executable("lbe_agent")).toEqual([...AGENT].sort()); });
  it("lbe_worker", async () => { expect(await executable("lbe_worker")).toEqual([...WORKER].sort()); });
  it("lbe_api", async () => { expect(await executable("lbe_api")).toEqual([...API].sort()); });
  it("PUBLIC can execute nothing in lbe", async () => {
    const rows = await t.db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'lbe' and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')`);
    expect(rows).toEqual([]);
  });
  it("operator-only functions are not granted to any application role", async () => {
    for (const fn of ["platform_set_stop", "purge_expired_sessions", "admin_create_user", "brain_write_entry", "require_user", "subject_org",
      "session_user_touch", "session_idle_timeout", "admin_target", "revoke_user_sessions", "require_user_core", "session_resolve", "job_json"]) {
      for (const role of ["lbe_api", "lbe_worker", "lbe_agent"]) {
        const [r] = await t.db.query<{ ok: boolean }>(`select bool_or(has_function_privilege($1, p.oid, 'execute')) as ok
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'lbe' and p.proname = $2`, [role, fn]);
        expect(r!.ok, `${role} → ${fn}`).toBe(false);
      }
    }
  });
});

describe("SECURITY DEFINER hygiene", () => {
  it("every definer function pins search_path, with pg_temp last", async () => {
    const rows = await t.db.query<{ proname: string; cfg: string | null }>(
      `select p.proname, array_to_string(p.proconfig, ',') as cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'lbe' and p.prosecdef`);
    expect(rows.length).toBeGreaterThan(40);
    for (const r of rows) {
      expect(r.cfg ?? "", r.proname).toMatch(/^search_path=lbe(, ?extensions, ?public)?, ?pg_temp$/);
    }
  });
  it("only functions that need pgcrypto include public in their search_path", async () => {
    const rows = await t.db.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'lbe' and p.prosecdef and array_to_string(p.proconfig, ',') like '%public%' order by 1`);
    expect(rows.map((r) => r.proname)).toEqual(["admin_create_user", "admin_reset_password", "begin_oauth", "change_password", "connector_create", "job_claim", "login"]);
  });
  it("no application role can create objects in the public schema (search_path hijack)", async () => {
    for (const role of ["lbe_api", "lbe_worker", "lbe_agent"]) {
      const [r] = await t.db.query<{ ok: boolean }>("select has_schema_privilege($1, 'public', 'create') as ok", [role]);
      expect(r!.ok, role).toBe(false);
    }
  });
});

describe("table privileges", () => {
  it("no application role holds INSERT/UPDATE/DELETE/TRUNCATE on any lbe table", async () => {
    const rows = await t.db.query(`select grantee, table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'lbe' and grantee in ('lbe_api', 'lbe_worker', 'lbe_agent') and privilege_type <> 'SELECT'`);
    expect(rows).toEqual([]);
  });
  it("lbe_agent cannot read any table directly", async () => {
    const rows = await t.db.query(`select table_name from information_schema.role_table_grants
      where table_schema in ('lbe', 'lbe_mock') and grantee = 'lbe_agent'`);
    expect(rows).toEqual([]);
  });
  it("Brand Brain, research and workflow tables are not directly readable by any application role", async () => {
    const rows = await t.db.query(`select grantee, table_name from information_schema.role_table_grants
      where table_schema = 'lbe' and grantee in ('lbe_api', 'lbe_worker', 'lbe_agent')
        and table_name in ('brand_entries', 'brand_proposals', 'research_findings', 'agent_workflows', 'content_strategies', 'organizations', 'sessions', 'oauth_states', 'agent_jobs', 'media_assets', 'content_revisions', 'campaigns')`);
    expect(rows).toEqual([]);
  });
});
