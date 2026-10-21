import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Provider, Run, RunEvent, RunStage, RunStatus } from '@dcc/core';
import { redact } from '@dcc/core';
import { Database, newId, nowIso } from '../db/database.js';
import { CONFIG } from '../config.js';
import { GitService } from './git.js';
import type { AuditService } from './audit.js';
import type { ProviderService } from './providers.js';
import type { TaskService } from './tasks.js';

export interface StartRunInput {
  taskId?: string | null;
  providerId: string;
  repoId?: string | null;
  stage?: RunStage;
  budgetSeconds?: number;
  /** Command for the generic CLI adapter (read-only evidence command). */
  command?: string;
}

/**
 * Run monitor.
 *
 * - Runs persist in SQLite; state survives worker/UI restarts.
 * - On startup, runs left "running" by a crash are marked `interrupted` —
 *   never silently treated as success.
 * - Each coding run gets its own Git worktree + branch; concurrent agents
 *   cannot overwrite one another's work.
 * - Providers that are not verified cannot produce fake successes: their runs
 *   fail with an explicit "execution path not verified" error.
 */
export class RunService {
  private readonly git = new GitService();

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly providers: ProviderService,
    private readonly tasks: TaskService,
  ) {}

  /** Crash recovery: anything still "running" after a restart is interrupted. */
  recoverInterruptedRuns(): number {
    const rows = this.db.query<{ id: string }>('SELECT id FROM runs WHERE status = ?', 'running');
    for (const row of rows) {
      this.db.run(
        `UPDATE runs SET status = 'interrupted', finished_at = ?, recovered = 1, error = 'Interrupted by application restart — state recovered' WHERE id = ?`,
        nowIso(), row.id,
      );
      this.addEvent(row.id, 'warn', 'Run interrupted by restart; state recovered from local database');
    }
    if (rows.length > 0) {
      this.audit.record({
        actor: 'system:recovery', action: 'run.recover', targetKind: 'run', outcome: 'ok',
        detail: `Marked ${rows.length} running run(s) as interrupted after restart`,
      });
    }
    return rows.length;
  }

  list(limit = 100): Run[] {
    return this.db.query<Record<string, unknown>>('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?', limit).map(toRun);
  }

  get(id: string): Run | undefined {
    const row = this.db.queryOne<Record<string, unknown>>('SELECT * FROM runs WHERE id = ?', id);
    return row ? toRun(row) : undefined;
  }

  listEvents(runId: string): RunEvent[] {
    return this.db
      .query<Record<string, unknown>>('SELECT * FROM run_events WHERE run_id = ? ORDER BY at ASC', runId)
      .map((row) => ({
        id: String(row.id),
        runId: String(row.run_id),
        at: String(row.at),
        kind: row.kind as RunEvent['kind'],
        message: String(row.message),
        data: row.data ? JSON.parse(String(row.data)) : null,
      }));
  }

  addEvent(runId: string, kind: RunEvent['kind'], message: string, data?: Record<string, unknown>): void {
    this.db.run(
      'INSERT INTO run_events (id, run_id, at, kind, message, data) VALUES (?, ?, ?, ?, ?, ?)',
      newId('rev'), runId, nowIso(), kind, redact(message).redacted, data ? JSON.stringify(data) : null,
    );
  }

  async start(input: StartRunInput, actor: string): Promise<{ ok: boolean; run?: Run; error?: string }> {
    const provider = this.providers.get(input.providerId);
    if (!provider) return { ok: false, error: 'Provider not found' };
    if (!provider.enabled) return { ok: false, error: `Provider "${provider.name}" is disabled` };

    const runId = newId('run');
    const now = nowIso();
    const run: Run = {
      id: runId,
      taskId: input.taskId ?? null,
      providerId: provider.id,
      repoId: input.repoId ?? null,
      stage: input.stage ?? 'implementation',
      status: 'queued',
      branchName: null,
      worktreePath: null,
      changedFiles: [],
      exitCode: null,
      error: null,
      budgetSeconds: input.budgetSeconds ?? 600,
      startedAt: null,
      finishedAt: null,
      createdAt: now,
      recovered: false,
    };
    this.db.run(
      `INSERT INTO runs (id, task_id, provider_id, repo_id, stage, status, branch_name, worktree_path, changed_files, exit_code, error, budget_seconds, started_at, finished_at, created_at, recovered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id, run.taskId, run.providerId, run.repoId, run.stage, run.status, run.branchName, run.worktreePath,
      JSON.stringify(run.changedFiles), run.exitCode, run.error, run.budgetSeconds, run.startedAt, run.finishedAt, run.createdAt, 0,
    );
    this.addEvent(runId, 'info', `Run queued with provider "${provider.name}" (${provider.status})`);
    if (run.taskId) {
      this.tasks.setExternalStatus(run.taskId, 'agent', 'running', actor);
    }
    this.audit.record({ actor, action: 'run.start', targetKind: 'run', targetId: runId, outcome: 'ok', data: { provider: provider.key, task: run.taskId } });

    // Execute asynchronously; the run row is the source of truth either way.
    void this.execute(run, provider, input.command, actor);
    return { ok: true, run: this.get(runId) };
  }

  private async execute(run: Run, provider: Provider, command: string | undefined, actor: string): Promise<void> {
    this.db.run(`UPDATE runs SET status = 'running', started_at = ? WHERE id = ?`, nowIso(), run.id);
    this.addEvent(run.id, 'status', 'Running');

    // Isolated worktree for coding runs on a registered repository.
    if (run.repoId && (provider.capabilities.filesystem || provider.capabilities.terminal)) {
      const repo = this.db.queryOne<{ local_path: string }>('SELECT local_path FROM repositories WHERE id = ?', run.repoId);
      if (repo) {
        const branchName = `agent/${run.id}`;
        const worktreePath = path.join(CONFIG.worktreeDir, run.id);
        const created = await this.git.createWorktree(String(repo.local_path), worktreePath, branchName);
        if (created.ok) {
          this.db.run('UPDATE runs SET branch_name = ?, worktree_path = ? WHERE id = ?', branchName, worktreePath, run.id);
          this.addEvent(run.id, 'info', `Isolated worktree created at ${worktreePath} (branch ${branchName})`);
        } else {
          this.addEvent(run.id, 'warn', `Worktree creation failed: ${created.error ?? 'unknown'}`);
        }
      }
    }

    try {
      if (provider.key === 'generic-cli') {
        await this.executeGenericCli(run, provider, command);
      } else if (provider.status !== 'verified') {
        // Honest failure: never pretend an unverified provider did work.
        const error = `Provider "${provider.name}" has status "${provider.status}" — execution path not verified. Run recorded as failed (no silent success).`;
        this.finish(run.id, 'failed', { error, exitCode: null });
        this.addEvent(run.id, 'error', error);
      } else {
        const error = `No execution adapter wired for provider "${provider.name}" yet (planned phase 3).`;
        this.finish(run.id, 'failed', { error });
        this.addEvent(run.id, 'error', error);
      }
    } catch (err) {
      const error = redact(err instanceof Error ? err.message : String(err)).redacted;
      this.finish(run.id, 'failed', { error });
      this.addEvent(run.id, 'error', error);
    }

    if (run.taskId) {
      const final = this.get(run.id);
      this.tasks.setExternalStatus(run.taskId, 'agent', final?.status === 'succeeded' ? 'passing' : 'failing', actor);
    }
    void provider;
  }

  /** Generic CLI adapter: safe, read-only evidence commands only. */
  private async executeGenericCli(run: Run, provider: Provider, command: string | undefined): Promise<void> {
    // Re-read the run row: execute() may have attached a worktree after start().
    const fresh = this.get(run.id) ?? run;
    const workDir = fresh.worktreePath;
    const defaultArgs = ['status', '--porcelain=v2', '--branch'];
    this.addEvent(run.id, 'command', `git ${defaultArgs.join(' ')}${command ? ` (requested: ${command})` : ''}`);

    const targetDir = workDir ?? (fresh.repoId ? String(this.db.queryOne<{ local_path: string }>('SELECT local_path FROM repositories WHERE id = ?', fresh.repoId)?.local_path ?? '') : '');

    if (command && /reset\s+--hard|clean\s+-f|push\s+--force/i.test(command)) {
      const error = 'Destructive commands are blocked for the generic CLI adapter (require explicit approval + dedicated executor).';
      this.finish(run.id, 'failed', { error });
      this.addEvent(run.id, 'error', error);
      return;
    }

    if (!targetDir) {
      const error = 'No repository/worktree associated with this run — nothing to inspect.';
      this.finish(run.id, 'failed', { error });
      this.addEvent(run.id, 'error', error);
      return;
    }

    const result = await this.git.captureState(targetDir);
    if (!result.ok) {
      this.finish(run.id, 'failed', { error: result.error ?? 'git inspection failed' });
      this.addEvent(run.id, 'error', result.error ?? 'git inspection failed');
      return;
    }

    const files = await this.git.changedFiles(targetDir);
    this.db.run('UPDATE runs SET changed_files = ? WHERE id = ?', JSON.stringify(files), run.id);
    const summary = `Git state: branch=${result.data?.branch ?? 'detached'} commit=${(result.data?.commitSha ?? '').slice(0, 8)} dirty=${result.data?.dirty} changed=${files.length}`;
    this.addEvent(run.id, 'evidence', summary);

    this.tasks.addEvidence({
      taskId: run.taskId ?? null,
      runId: run.id,
      kind: 'git_snapshot',
      summary,
      content: JSON.stringify(result.data, null, 2),
      source: 'command',
    });

    void provider;
    this.finish(run.id, 'succeeded', { exitCode: 0 });
  }

  private finish(runId: string, status: RunStatus, opts: { error?: string; exitCode?: number | null } = {}): void {
    this.db.run(
      'UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, error = ? WHERE id = ?',
      status, nowIso(), opts.exitCode ?? null, opts.error ? redact(opts.error).redacted : null, runId,
    );
    this.addEvent(runId, 'status', `Run finished: ${status}`);
  }

  async cancel(runId: string, actor: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.get(runId);
    if (!run) return { ok: false, error: 'Run not found' };
    if (['succeeded', 'failed', 'cancelled', 'timeout'].includes(run.status)) {
      return { ok: false, error: `Run already finished (${run.status})` };
    }
    this.db.run(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ?`, nowIso(), runId);
    this.addEvent(runId, 'warn', `Run cancelled by ${actor}`);
    this.audit.record({ actor, action: 'run.cancel', targetKind: 'run', targetId: runId, outcome: 'ok' });
    return { ok: true };
  }

  activeRuns(): Run[] {
    return this.db.query<Record<string, unknown>>(`SELECT * FROM runs WHERE status IN ('queued','running') ORDER BY created_at DESC`).map(toRun);
  }
}

export function toRun(row: Record<string, unknown>): Run {
  return {
    id: String(row.id),
    taskId: (row.task_id as string) ?? null,
    providerId: (row.provider_id as string) ?? null,
    repoId: (row.repo_id as string) ?? null,
    stage: row.stage as RunStage,
    status: row.status as RunStatus,
    branchName: (row.branch_name as string) ?? null,
    worktreePath: (row.worktree_path as string) ?? null,
    changedFiles: JSON.parse(String(row.changed_files ?? '[]')),
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    error: (row.error as string) ?? null,
    budgetSeconds: Number(row.budget_seconds ?? 600),
    startedAt: (row.started_at as string) ?? null,
    finishedAt: (row.finished_at as string) ?? null,
    createdAt: String(row.created_at),
    recovered: Number(row.recovered ?? 0) === 1,
  };
}
