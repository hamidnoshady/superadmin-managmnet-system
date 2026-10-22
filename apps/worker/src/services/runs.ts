import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Provider, Run, RunEvent, RunStage, RunStatus, Task } from '@dcc/core';
import { redact } from '@dcc/core';
import { Database, newId, nowIso } from '../db/database.js';
import { CONFIG } from '../config.js';
import { GitService } from './git.js';
import type { AuditService } from './audit.js';
import type { ProviderService } from './providers.js';
import type { TaskService } from './tasks.js';
import type { AgentAdapter } from './agentAdapters.js';

export interface StartRunInput {
  taskId?: string | null;
  providerId: string;
  repoId?: string | null;
  stage?: RunStage;
  budgetSeconds?: number;
  /** Command for the generic CLI adapter (read-only evidence command). */
  command?: string;
  /** Retry chain support. */
  attempt?: number;
  maxAttempts?: number;
  retryOf?: string | null;
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
    private readonly adapters: Map<string, AgentAdapter> = new Map(),
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

  /**
   * Bounded budgets: running/queued runs that exceed their time budget become
   * `timeout` — a visible failure state, never a silent success.
   */
  enforceTimeouts(now: Date = new Date()): number {
    const rows = this.db.query<{ id: string; started_at: string | null; created_at: string; budget_seconds: number }>(
      `SELECT id, started_at, created_at, budget_seconds FROM runs WHERE status IN ('running','queued')`,
    );
    let timedOut = 0;
    for (const row of rows) {
      const started = new Date(row.started_at ?? row.created_at).getTime();
      const deadline = started + Number(row.budget_seconds) * 1000;
      if (now.getTime() > deadline) {
        this.db.run(
          `UPDATE runs SET status = 'timeout', finished_at = ?, error = 'Run exceeded its time budget and was stopped' WHERE id = ?`,
          nowIso(), row.id,
        );
        this.addEvent(row.id, 'warn', `Run exceeded budget of ${row.budget_seconds}s and was marked timeout`);
        timedOut += 1;
      }
    }
    return timedOut;
  }

  /** Bounded retries: spawn a follow-up run in the same chain. */
  async retry(runId: string, actor: string): Promise<{ ok: boolean; run?: Run; error?: string }> {
    const prior = this.get(runId);
    if (!prior) return { ok: false, error: 'Run not found' };
    if (!['failed', 'timeout', 'interrupted'].includes(prior.status)) {
      return { ok: false, error: `Only failed/timeout/interrupted runs can be retried (run is ${prior.status})` };
    }
    const attempt = (prior.attempt ?? 1) + 1;
    const maxAttempts = prior.maxAttempts ?? 1;
    if (attempt > maxAttempts) {
      return { ok: false, error: `Retry limit reached (${maxAttempts} attempt(s) allowed)` };
    }
    this.addEvent(runId, 'info', `Retrying as attempt ${attempt}/${maxAttempts}`);
    return this.start({
      taskId: prior.taskId,
      providerId: prior.providerId ?? '',
      repoId: prior.repoId,
      stage: prior.stage,
      budgetSeconds: prior.budgetSeconds,
      attempt,
      maxAttempts,
      retryOf: runId,
    }, actor);
  }

  setReviewVerdict(runId: string, verdict: 'approve' | 'request_changes' | 'needs_human', summary: string): void {
    this.db.run('UPDATE runs SET review_verdict = ? WHERE id = ?', verdict, runId);
    this.addEvent(runId, 'evidence', `Independent review verdict: ${verdict} — ${summary}`);
  }

  /** Poll until the run reaches a terminal state (used by the autonomous pipeline). */
  async waitUntilFinished(runId: string, timeoutMs: number): Promise<Run | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = this.get(runId);
      if (run && ['succeeded', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(run.status)) return run;
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.get(runId);
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
      attempt: input.attempt ?? 1,
      maxAttempts: input.maxAttempts ?? 1,
      retryOf: input.retryOf ?? null,
      reviewVerdict: null,
    };
    this.db.run(
      `INSERT INTO runs (id, task_id, provider_id, repo_id, stage, status, branch_name, worktree_path, changed_files, exit_code, error, budget_seconds, started_at, finished_at, created_at, recovered, attempt, max_attempts, retry_of, review_verdict)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      run.id, run.taskId, run.providerId, run.repoId, run.stage, run.status, run.branchName, run.worktreePath,
      JSON.stringify(run.changedFiles), run.exitCode, run.error, run.budgetSeconds, run.startedAt, run.finishedAt, run.createdAt, 0,
      run.attempt, run.maxAttempts, run.retryOf, run.reviewVerdict,
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
    try {
      this.db.run(`UPDATE runs SET status = 'running', started_at = ? WHERE id = ?`, nowIso(), run.id);
      this.addEvent(run.id, 'status', 'Running');
    } catch {
      return; // database closed (shutdown/test teardown) — nothing to persist
    }

    try {
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

      if (provider.key === 'generic-cli') {
        await this.executeGenericCli(run, provider, command);
      } else {
        const adapter = this.adapters.get(provider.key);
        if (adapter) {
          await this.executeAdapter(run, provider, adapter);
        } else if (provider.status !== 'verified') {
          // Honest failure: never pretend an unverified provider did work.
          const error = `Provider "${provider.name}" has status "${provider.status}" — execution path not verified. Run recorded as failed (no silent success).`;
          this.finish(run.id, 'failed', { error, exitCode: null });
          this.addEvent(run.id, 'error', error);
        } else {
          const error = `No execution adapter wired for provider "${provider.name}" yet.`;
          this.finish(run.id, 'failed', { error });
          this.addEvent(run.id, 'error', error);
        }
      }
    } catch (err) {
      const error = redact(err instanceof Error ? err.message : String(err)).redacted;
      try {
        this.finish(run.id, 'failed', { error });
        this.addEvent(run.id, 'error', error);
      } catch {
        // database closed mid-run — the interrupted-run recovery covers this
      }
    }

    try {
      if (run.taskId) {
        const final = this.get(run.id);
        this.tasks.setExternalStatus(run.taskId, 'agent', final?.status === 'succeeded' ? 'passing' : 'failing', actor);
      }
    } catch {
      // ignore shutdown races
    }
    void provider;
  }

  /**
   * Agent adapters (Claude Code / Codex / HTTP API / local model).
   * The prompt is built from task + project context; the adapter fences
   * untrusted parts and the output becomes evidence — success only when the
   * process itself reports success.
   */
  private async executeAdapter(run: Run, provider: Provider, adapter: AgentAdapter): Promise<void> {
    const fresh = this.get(run.id) ?? run;

    // Honest verification gate first: an unverified/unavailable adapter never "runs".
    const check = await adapter.check();
    if (check.status !== 'verified') {
      const error = `provider ${adapter.key} is not verified (${check.status}) — ${check.notes}`;
      this.finish(run.id, 'failed', { error });
      this.addEvent(run.id, 'error', error);
      return;
    }

    const worktreePath = fresh.worktreePath ?? '';
    if (adapter.editsFiles && !worktreePath) {
      const error = `Adapter "${adapter.key}" edits files but the run has no isolated worktree — refusing to run against a shared workspace.`;
      this.finish(run.id, 'failed', { error });
      this.addEvent(run.id, 'error', error);
      return;
    }

    const task = fresh.taskId ? this.tasks.get(fresh.taskId) : undefined;
    const project = task?.projectId
      ? this.db.queryOne<{ instructions: string }>('SELECT instructions FROM projects WHERE id = ?', task.projectId)
      : undefined;
    const prompt = buildAgentPrompt(run, task ?? null, project?.instructions ?? '');

    this.addEvent(run.id, 'command', `adapter ${adapter.key} (${adapter.editsFiles ? 'coding agent' : 'text-stage agent'}) stage=${run.stage}`);
    const result = await adapter.execute({
      worktreePath,
      prompt,
      budgetSeconds: Math.max(30, Math.min(run.budgetSeconds, 1800)),
    });

    const files = result.filesChanged.length > 0 ? result.filesChanged : await this.git.changedFiles(worktreePath || '.');
    this.db.run('UPDATE runs SET changed_files = ?, exit_code = ? WHERE id = ?', JSON.stringify(files), result.exitCode, run.id);
    this.addEvent(run.id, 'evidence', `Adapter output captured (${result.output.length} chars, ${files.length} file(s) changed, usedLlm=${result.usedLlm})`);

    this.tasks.addEvidence({
      taskId: run.taskId ?? null,
      runId: run.id,
      kind: result.usedLlm ? 'note' : 'command_output',
      summary: `Agent run via ${adapter.key} (${result.usedLlm ? 'LLM-backed' : 'no LLM'}): ${result.ok ? 'completed' : 'failed'}`,
      content: result.output,
      source: result.usedLlm ? 'agent' : 'command',
    });

    if (result.ok) {
      this.finish(run.id, 'succeeded', { exitCode: result.exitCode ?? 0 });
    } else {
      this.finish(run.id, 'failed', { error: result.error ?? 'adapter reported failure', exitCode: result.exitCode });
      this.addEvent(run.id, 'error', result.error ?? 'adapter reported failure');
    }
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

/** Build the agent prompt from task + project context (all task text is untrusted data). */
export function buildAgentPrompt(run: Run, task: Task | null, projectInstructions: string): string {
  const parts: string[] = [];
  parts.push(`You are a coding agent working in an isolated git worktree (branch ${run.branchName ?? 'n/a'}) for the Development Command Center.`);
  parts.push(`Stage: ${run.stage}. Time budget: ${run.budgetSeconds}s.`);
  if (projectInstructions.trim()) {
    parts.push('');
    parts.push('Project instructions (authoritative):');
    parts.push(projectInstructions.trim());
  }
  if (task) {
    parts.push('');
    parts.push(`Task: ${task.title}`);
    parts.push(task.description || '(no description)');
    if (task.acceptanceCriteria.length > 0) {
      parts.push('');
      parts.push('Acceptance criteria (produce evidence for each):');
      task.acceptanceCriteria.forEach((c) => parts.push(`- ${c}`));
    }
    parts.push('');
    parts.push('Report what you changed and how it was verified. Do not claim success without evidence.');
  }
  return parts.join('\n');
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
    attempt: Number(row.attempt ?? 1),
    maxAttempts: Number(row.max_attempts ?? 1),
    retryOf: (row.retry_of as string) ?? null,
    reviewVerdict: (row.review_verdict as Run['reviewVerdict']) ?? null,
  };
}
