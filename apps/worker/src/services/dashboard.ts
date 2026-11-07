import type { DashboardSummary, SourcedStatus, Task } from '@dcc/core';
import { findStaleWork, makeSourcedStatus, isStale } from '@dcc/core';
import { Database, nowIso } from '../db/database.js';
import type { SettingsService } from './settings.js';

const ACTIVE_TASK_STATUSES = ['Investigating', 'In Development', 'Testing', 'Review', 'Planned'];

/**
 * Dashboard aggregation. Every item is a SourcedStatus: the UI can always show
 * where the value came from, when it was last updated, and whether it is
 * confirmed / inferred / stale / unavailable.
 */
export class DashboardService {
  constructor(
    private readonly db: Database,
    private readonly settings: SettingsService,
  ) {}

  summary(): DashboardSummary {
    const now = new Date();
    const staleAfter = this.settings.get().staleAfterMinutes;
    const items: SourcedStatus[] = [];

    const projectCount = Number(this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM projects')?.n ?? 0);
    const repos = this.db.query<{ id: string; git_state: string | null; git_state_captured_at: string | null; git_state_error: string | null; github_sync_error: string | null }>(
      'SELECT id, git_state, git_state_captured_at, git_state_error, github_sync_error FROM repositories',
    );
    const dirtyRepos = repos.filter((r) => {
      try { return r.git_state ? Boolean(JSON.parse(r.git_state).dirty) : false; } catch { return false; }
    }).length;
    const syncErrors = repos.filter((r) => r.git_state_error || r.github_sync_error).length;
    const lastRefresh = repos
      .map((r) => r.git_state_captured_at)
      .filter(Boolean)
      .sort()
      .pop() ?? null;

    const tasks = this.db.query<Record<string, unknown>>('SELECT * FROM tasks').map(rowToTaskLike);
    const tasksByStatus: Record<string, number> = {};
    for (const t of tasks) tasksByStatus[t.internalStatus] = (tasksByStatus[t.internalStatus] ?? 0) + 1;

    const openIssues = Number(this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM github_issues WHERE state = 'open'`)?.n ?? 0);
    const openPrs = Number(this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM github_prs WHERE state = 'open'`)?.n ?? 0);
    const failingCi = Number(this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM github_prs WHERE ci_status IS NOT NULL AND ci_status NOT IN ('clean','success','passing')`)?.n ?? 0);
    const lastGithubSync = this.db.queryOne<{ last_sync_at: string | null }>(
      `SELECT MAX(last_sync_at) AS last_sync_at FROM sync_checkpoints WHERE resource = 'github'`,
    )?.last_sync_at ?? null;

    const supportCounts = this.db.queryOne<Record<string, number>>(
      `SELECT
         SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_count,
         SUM(CASE WHEN status = 'triaging' THEN 1 ELSE 0 END) AS triaging,
         SUM(CASE WHEN status = 'linked' THEN 1 ELSE 0 END) AS linked,
         SUM(CASE WHEN status = 'needs_evidence' THEN 1 ELSE 0 END) AS needs_evidence
       FROM support_reports`,
    ) ?? {};

    const activeRuns = Number(this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')`)?.n ?? 0);
    const failedRuns = Number(this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE status = 'failed'`)?.n ?? 0);
    const interruptedRuns = Number(this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE status = 'interrupted'`)?.n ?? 0);
    const pendingApprovals = Number(this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'`)?.n ?? 0);

    const providers = this.db.query<{ status: string }>('SELECT status FROM providers WHERE enabled = 1');
    const verifiedProviders = providers.filter((p) => p.status === 'verified').length;

    const staleWork = findStaleWork(
      tasks.map((t) => ({
        id: t.id,
        kind: 'task',
        title: t.title,
        updatedAt: t.updatedAt,
        activityStatus: t.internalStatus,
        activeStatuses: ACTIVE_TASK_STATUSES,
        dueAt: t.dueAt ?? null,
      })),
      staleAfter,
      now,
    );

    // Sourced status items for the "evidence" strip on the dashboard.
    items.push(makeSourcedStatus({
      label: 'Git state',
      value: lastRefresh ? `${repos.length} repos tracked, ${dirtyRepos} with uncommitted changes` : 'no refresh yet',
      source: 'git',
      updatedAt: lastRefresh,
      confirmed: true,
      staleAfterMinutes: staleAfter,
      now,
    }));

    items.push(makeSourcedStatus({
      label: 'GitHub sync',
      value: lastGithubSync ? `${openIssues} open issues, ${openPrs} open PRs` : 'never synced',
      source: 'github_api',
      updatedAt: lastGithubSync,
      confirmed: true,
      unavailable: !lastGithubSync,
      staleAfterMinutes: staleAfter,
      now,
    }));

    items.push(makeSourcedStatus({
      label: 'Biza Miz support API',
      value: 'not connected — manual intake only',
      source: 'biza_miz',
      updatedAt: null,
      confirmed: true,
      unavailable: true,
      now,
    }));

    items.push(makeSourcedStatus({
      label: 'Provider readiness',
      value: `${verifiedProviders}/${providers.length} enabled providers verified`,
      source: 'provider_registry',
      updatedAt: nowIso(),
      confirmed: true,
      now,
    }));

    items.push(makeSourcedStatus({
      label: 'Stale work',
      value: `${staleWork.length} item(s) need attention`,
      source: 'inferred',
      updatedAt: nowIso(),
      confirmed: false,
      now,
    }));

    return {
      generatedAt: nowIso(),
      projects: { total: projectCount, withRepos: repos.length },
      repositories: { total: repos.length, dirty: dirtyRepos, syncErrors, lastRefresh },
      tasks: tasksByStatus,
      github: { openIssues, openPrs, failingCi, lastSync: lastGithubSync },
      support: {
        new: Number(supportCounts.new_count ?? 0),
        triaging: Number(supportCounts.triaging ?? 0),
        linked: Number(supportCounts.linked ?? 0),
        needsEvidence: Number(supportCounts.needs_evidence ?? 0),
      },
      runs: { active: activeRuns, failed: failedRuns, interrupted: interruptedRuns },
      approvals: { pending: pendingApprovals },
      staleWork: staleWork.length,
      providers: { verified: verifiedProviders, total: providers.length },
      items,
    };
  }

  staleWorkItems(): ReturnType<typeof findStaleWork> {
    const staleAfter = this.settings.get().staleAfterMinutes;
    const tasks = this.db.query<Record<string, unknown>>('SELECT * FROM tasks').map(rowToTaskLike);
    return findStaleWork(
      tasks.map((t) => ({
        id: t.id,
        kind: 'task',
        title: t.title,
        updatedAt: t.updatedAt,
        activityStatus: t.internalStatus,
        activeStatuses: ACTIVE_TASK_STATUSES,
        dueAt: t.dueAt ?? null,
      })),
      staleAfter,
    );
  }

  /** Global search across projects, tasks, support reports, and runs. */
  search(q: string): Record<string, unknown[]> {
    const like = `%${q}%`;
    return {
      tasks: this.db.query('SELECT id, title, internal_status AS status FROM tasks WHERE title LIKE ? OR description LIKE ? LIMIT 20', like, like),
      projects: this.db.query('SELECT id, name FROM projects WHERE name LIKE ? OR description LIKE ? LIMIT 20', like, like),
      support: this.db.query('SELECT id, title, status FROM support_reports WHERE title LIKE ? OR body_redacted LIKE ? LIMIT 20', like, like),
      runs: this.db.query('SELECT id, status, stage FROM runs WHERE id LIKE ? LIMIT 20', like),
    };
  }
}

function rowToTaskLike(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description ?? ''),
    projectId: (row.project_id as string) ?? null,
    repoId: (row.repo_id as string) ?? null,
    internalStatus: String(row.internal_status) as Task['internalStatus'],
    githubStatus: String(row.github_status) as Task['githubStatus'],
    agentStatus: String(row.agent_status) as Task['agentStatus'],
    testStatus: String(row.test_status) as Task['testStatus'],
    prStatus: String(row.pr_status) as Task['prStatus'],
    deployStatus: String(row.deploy_status) as Task['deployStatus'],
    severity: String(row.severity) as Task['severity'],
    acceptanceCriteria: JSON.parse(String(row.acceptance_criteria ?? '[]')),
    source: String(row.source) as Task['source'],
    sourceRef: (row.source_ref as string) ?? null,
    dueAt: (row.due_at as string) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

void isStale;
