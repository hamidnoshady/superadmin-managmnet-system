import type { Discrepancy, SourcedStatus, Task } from '@dcc/core';
import { findDiscrepancies, makeSourcedStatus } from '@dcc/core';
import { Database, nowIso } from '../db/database.js';
import type { SettingsService } from './settings.js';

export interface EngineeringHealth {
  generatedAt: string;
  cycle: {
    completedTasks: number;
    avgCycleHours: number | null;
    completionRate: number;
  };
  quality: {
    evidenceBackedCompleted: number;
    evidenceCoverage: number;
    failingTestTasks: number;
    reviewApprovals: number;
    reviewRequestsChanges: number;
  };
  runs: {
    total: number;
    succeeded: number;
    failed: number;
    timeout: number;
    interrupted: number;
    cancelled: number;
    successRate: number;
  };
  providers: { verified: number; total: number; unverified: number };
  github: { openIssues: number; openPrs: number; lastSync: string | null; syncAgeMinutes: number | null };
  support: { open: number; avgAgeHours: number | null };
  releaseReadiness: {
    readyForMerge: number;
    releaseBlockers: Array<{ taskId: string; title: string; reason: string }>;
    ciConcerns: number;
    verdict: 'ready' | 'not-ready';
  };
  discrepancies: Discrepancy[];
  items: SourcedStatus[];
}

/**
 * Engineering health metrics — computed from the local evidence store.
 * Recommendations and aggregates are `inferred`; raw counts cite the DB.
 */
export class HealthService {
  constructor(
    private readonly db: Database,
    private readonly settings: SettingsService,
  ) {}

  compute(): EngineeringHealth {
    const now = new Date();
    const staleAfter = this.settings.get().staleAfterMinutes;

    // ---- Cycle -------------------------------------------------------------
    const tasks = this.db.query<Record<string, unknown>>('SELECT * FROM tasks').map(rowToTask);
    const completed = tasks.filter((t) => t.internalStatus === 'Completed');
    const cycleHours = completed
      .map((t) => (new Date(t.updatedAt).getTime() - new Date(t.createdAt).getTime()) / 3_600_000)
      .filter((h) => h >= 0);
    const avgCycleHours = cycleHours.length > 0 ? Number((cycleHours.reduce((a, b) => a + b, 0) / cycleHours.length).toFixed(1)) : null;
    const completionRate = tasks.length > 0 ? Number((completed.length / tasks.length).toFixed(2)) : 0;

    // ---- Quality -----------------------------------------------------------
    const completedWithEvidence = completed.filter((t) =>
      (this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM evidence WHERE task_id = ?', t.id)?.n ?? 0) > 0,
    ).length;
    const failingTestTasks = tasks.filter((t) => t.testStatus === 'failing').length;
    const reviewApprovals = Number(this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE review_verdict = 'approve'`)?.n ?? 0);
    const reviewChanges = Number(this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE review_verdict = 'request_changes'`)?.n ?? 0);

    // ---- Runs ---------------------------------------------------------------
    const runRows = this.db.query<{ status: string }>('SELECT status FROM runs');
    const count = (s: string) => runRows.filter((r) => r.status === s).length;
    const succeeded = count('succeeded');
    const failed = count('failed');
    const timeout = count('timeout');
    const interrupted = count('interrupted');
    const cancelled = count('cancelled');
    const successRate = runRows.length > 0 ? Number((succeeded / runRows.length).toFixed(2)) : 0;

    // ---- Providers -----------------------------------------------------------
    const providers = this.db.query<{ status: string }>('SELECT status FROM providers');
    const verified = providers.filter((p) => p.status === 'verified').length;
    const unverified = providers.filter((p) => p.status === 'unverified').length;

    // ---- GitHub ---------------------------------------------------------------
    const openIssues = Number(this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM github_issues WHERE state = 'open'`)?.n ?? 0);
    const openPrs = Number(this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM github_prs WHERE state = 'open'`)?.n ?? 0);
    const lastSync = this.db.queryOne<{ last_sync_at: string | null }>(
      `SELECT MAX(last_sync_at) AS last_sync_at FROM sync_checkpoints WHERE resource = 'github'`,
    )?.last_sync_at ?? null;
    const syncAgeMinutes = lastSync ? (now.getTime() - new Date(lastSync).getTime()) / 60_000 : null;

    // ---- Support ---------------------------------------------------------------
    const supportOpen = this.db.query<Record<string, string>>('SELECT received_at FROM support_reports WHERE status NOT IN (\'resolved\',\'closed\')');
    const ages = supportOpen.map((r) => (now.getTime() - new Date(r.received_at).getTime()) / 3_600_000);
    const avgAgeHours = ages.length > 0 ? Number((ages.reduce((a, b) => a + b, 0) / ages.length).toFixed(1)) : null;

    // ---- Discrepancies & release readiness -------------------------------------
    const discrepancies = findDiscrepancies(tasks);
    const readyForMerge = tasks.filter((t) => t.internalStatus === 'Ready for Merge').length;
    const releaseBlockers = tasks
      .filter((t) => ['Blocked', 'Failed'].includes(t.internalStatus) && ['critical', 'high'].includes(t.severity))
      .map((t) => ({ taskId: t.id, title: t.title, reason: `${t.internalStatus} (${t.severity})` }));
    const ciConcerns = Number(this.db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM github_prs WHERE state = 'open' AND ci_status IS NOT NULL AND ci_status NOT IN ('clean','success','passing')`,
    )?.n ?? 0);
    const verdict: 'ready' | 'not-ready' = releaseBlockers.length === 0 && ciConcerns === 0 ? 'ready' : 'not-ready';

    const items: SourcedStatus[] = [
      makeSourcedStatus({
        label: 'Run success rate',
        value: `${Math.round(successRate * 100)}% (${succeeded}/${runRows.length})`,
        source: 'local_db',
        updatedAt: nowIso(),
        confirmed: true,
        staleAfterMinutes: staleAfter,
        now,
      }),
      makeSourcedStatus({
        label: 'Evidence coverage (completed)',
        value: completed.length > 0 ? `${Math.round((completedWithEvidence / completed.length) * 100)}%` : 'no completed tasks yet',
        source: 'local_db',
        updatedAt: nowIso(),
        confirmed: true,
        now,
      }),
      makeSourcedStatus({
        label: 'GitHub freshness',
        value: syncAgeMinutes == null ? 'never synced' : `last sync ${Math.round(syncAgeMinutes)}m ago`,
        source: 'github_api',
        updatedAt: lastSync,
        confirmed: true,
        unavailable: lastSync == null,
        staleAfterMinutes: staleAfter,
        now,
      }),
      makeSourcedStatus({
        label: 'Release readiness',
        value: verdict === 'ready' ? 'no active blockers detected' : `${releaseBlockers.length} blocker(s), ${ciConcerns} CI concern(s)`,
        source: 'inferred',
        updatedAt: nowIso(),
        confirmed: false,
        now,
      }),
    ];

    return {
      generatedAt: nowIso(),
      cycle: { completedTasks: completed.length, avgCycleHours, completionRate },
      quality: {
        evidenceBackedCompleted: completedWithEvidence,
        evidenceCoverage: completed.length > 0 ? Number((completedWithEvidence / completed.length).toFixed(2)) : 0,
        failingTestTasks,
        reviewApprovals,
        reviewRequestsChanges: reviewChanges,
      },
      runs: {
        total: runRows.length,
        succeeded, failed, timeout, interrupted, cancelled,
        successRate,
      },
      providers: { verified, total: providers.length, unverified },
      github: { openIssues, openPrs, lastSync, syncAgeMinutes },
      support: { open: supportOpen.length, avgAgeHours },
      releaseReadiness: { readyForMerge, releaseBlockers, ciConcerns, verdict },
      discrepancies,
      items,
    };
  }
}

function rowToTask(row: Record<string, unknown>): Task {
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
