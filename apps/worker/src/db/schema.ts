export const SCHEMA_VERSION = 3;

/**
 * Full schema for fresh databases (v2). Additive migrations for older files
 * live in Database.migrate() — never destructive, never dropping data.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  root_path     TEXT,
  instructions  TEXT NOT NULL DEFAULT '',
  build_command TEXT,
  test_command  TEXT,
  agent_policy  TEXT NOT NULL DEFAULT '{}',
  environment_refs TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT,
  name                TEXT NOT NULL,
  local_path          TEXT NOT NULL UNIQUE,
  remote_url          TEXT,
  github_owner        TEXT,
  github_repo         TEXT,
  default_branch      TEXT,
  git_state           TEXT,
  git_state_captured_at TEXT,
  git_state_error     TEXT,
  last_github_sync_at TEXT,
  github_sync_error   TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                  TEXT PRIMARY KEY,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  project_id          TEXT,
  repo_id             TEXT,
  internal_status     TEXT NOT NULL,
  github_status       TEXT NOT NULL DEFAULT 'unknown',
  agent_status        TEXT NOT NULL DEFAULT 'unknown',
  test_status         TEXT NOT NULL DEFAULT 'unknown',
  pr_status           TEXT NOT NULL DEFAULT 'unknown',
  deploy_status       TEXT NOT NULL DEFAULT 'unknown',
  severity            TEXT NOT NULL DEFAULT 'unknown',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  source              TEXT NOT NULL DEFAULT 'manual',
  source_ref          TEXT,
  due_at              TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_links (
  id       TEXT PRIMARY KEY,
  task_id  TEXT NOT NULL,
  kind     TEXT NOT NULL,
  ref      TEXT NOT NULL,
  url      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id              TEXT PRIMARY KEY,
  task_id         TEXT,
  run_id          TEXT,
  kind            TEXT NOT NULL,
  summary         TEXT NOT NULL,
  ref             TEXT,
  content_preview TEXT,
  source          TEXT NOT NULL,
  produced_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS providers (
  id             TEXT PRIMARY KEY,
  key            TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  execution_method TEXT NOT NULL,
  auth_method    TEXT NOT NULL,
  status         TEXT NOT NULL,
  capabilities   TEXT NOT NULL DEFAULT '{}',
  models         TEXT NOT NULL DEFAULT '[]',
  prerequisites  TEXT NOT NULL DEFAULT '[]',
  limitations    TEXT NOT NULL DEFAULT '[]',
  last_checked_at TEXT,
  check_notes    TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  task_id       TEXT,
  provider_id   TEXT,
  repo_id       TEXT,
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL,
  branch_name   TEXT,
  worktree_path TEXT,
  changed_files TEXT NOT NULL DEFAULT '[]',
  exit_code     INTEGER,
  error         TEXT,
  budget_seconds INTEGER NOT NULL DEFAULT 600,
  started_at    TEXT,
  finished_at   TEXT,
  created_at    TEXT NOT NULL,
  recovered     INTEGER NOT NULL DEFAULT 0,
  attempt       INTEGER NOT NULL DEFAULT 1,
  max_attempts  INTEGER NOT NULL DEFAULT 1,
  retry_of      TEXT,
  review_verdict TEXT
);

CREATE TABLE IF NOT EXISTS run_events (
  id      TEXT PRIMARY KEY,
  run_id  TEXT NOT NULL,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  message TEXT NOT NULL,
  data    TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  title        TEXT NOT NULL,
  payload      TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT NOT NULL,
  decided_by   TEXT,
  decided_at   TEXT,
  reason       TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id   TEXT,
  outcome     TEXT NOT NULL,
  detail      TEXT,
  data        TEXT
);

CREATE TABLE IF NOT EXISTS support_reports (
  id                TEXT PRIMARY KEY,
  channel           TEXT NOT NULL,
  external_ref      TEXT,
  title             TEXT NOT NULL,
  body_raw          TEXT NOT NULL,
  body_redacted     TEXT NOT NULL,
  product_module    TEXT,
  app_version       TEXT,
  environment       TEXT,
  tenant_ref_hash   TEXT,
  severity          TEXT NOT NULL DEFAULT 'unknown',
  status            TEXT NOT NULL DEFAULT 'new',
  triage_category   TEXT,
  triage_notes      TEXT,
  duplicate_of_id   TEXT,
  duplicate_score   REAL,
  linked_task_id    TEXT,
  received_at       TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_drafts (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  repo_id     TEXT,
  labels      TEXT NOT NULL DEFAULT '[]',
  task_title  TEXT NOT NULL DEFAULT '',
  source_kind TEXT NOT NULL DEFAULT 'manual',
  source_id   TEXT,
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS github_issues (
  id          TEXT PRIMARY KEY,
  repo_id     TEXT NOT NULL,
  number      INTEGER NOT NULL,
  title       TEXT NOT NULL,
  state       TEXT NOT NULL,
  labels      TEXT NOT NULL DEFAULT '[]',
  assignees   TEXT NOT NULL DEFAULT '[]',
  milestone   TEXT,
  author      TEXT NOT NULL DEFAULT '',
  url         TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  synced_at   TEXT NOT NULL,
  UNIQUE(repo_id, number)
);

CREATE TABLE IF NOT EXISTS github_prs (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL,
  number         INTEGER NOT NULL,
  title          TEXT NOT NULL,
  state          TEXT NOT NULL,
  draft          INTEGER NOT NULL DEFAULT 0,
  review_decision TEXT,
  mergeable      TEXT,
  ci_status      TEXT,
  head_sha       TEXT,
  url            TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  synced_at      TEXT NOT NULL,
  UNIQUE(repo_id, number)
);

CREATE TABLE IF NOT EXISTS sync_checkpoints (
  id           TEXT PRIMARY KEY,
  repo_id      TEXT NOT NULL,
  resource     TEXT NOT NULL,
  last_sync_at TEXT,
  last_error   TEXT,
  status       TEXT NOT NULL DEFAULT 'never',
  UNIQUE(repo_id, resource)
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'blocks',
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS brain_findings (
  id          TEXT PRIMARY KEY,
  task_id     TEXT,
  run_id      TEXT,
  stage       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  detail      TEXT,
  confidence  TEXT NOT NULL DEFAULT 'confirmed',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_batches (
  id         TEXT PRIMARY KEY,
  channel    TEXT NOT NULL,
  source     TEXT,
  imported   INTEGER NOT NULL DEFAULT 0,
  skipped    INTEGER NOT NULL DEFAULT 0,
  errors     TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pr_preparations (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  task_id    TEXT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'draft',
  pr_url     TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(internal_status);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id);
CREATE INDEX IF NOT EXISTS idx_support_status ON support_reports(status);
`;
