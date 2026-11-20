// Where backups live (P1-01, P0-07, P9-04). All under backups/, which is git-ignored (business data).
import path from "node:path";
import { REPO_ROOT } from "./config.ts";

export const BACKUPS_DIR = path.join(REPO_ROOT, "backups");
/** Automatic backups taken by the running server, one folder per environment. */
export const autoBackupDir = (environment: string, root = REPO_ROOT) => path.join(root, "backups", "auto", environment);
/** Written after each successful USB/external copy; read by the dashboard to remind the owner when one is due. */
export const externalMarkerFor = (root: string) => path.join(root, "backups", "last-external-copy.json");
export const EXTERNAL_MARKER = externalMarkerFor(REPO_ROOT);
