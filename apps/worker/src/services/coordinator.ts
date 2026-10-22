import { execFile } from 'node:child_process';
import path from 'node:path';
import type { Run, Task, Provider } from '@dcc/core';
import {
  buildPrDraftBody,
  inferRequirements,
  recommendProviders,
  redact,
  reviewChanges,
  truncateEvidencePreview,
  type ProviderRecommendation,
} from '@dcc/core';
import { Database, newId, nowIso } from '../db/database.js';
import type { AuditService } from './audit.js';
import type { TaskService } from './tasks.js';
import type { RunService } from './runs.js';
import type { ProviderService } from './providers.js';
import type { RegistryService } from './registry.js';

export interface ConflictCheck {
  ok: boolean;
  conflicts: Array<{ code: string; message: string; runId?: string }>;
}

export interface AssignInput {
  taskId: string;
  providerId?: string | null;
  repoId?: string | null;
  budgetSeconds?: number;
  maxAttempts?: number;
  acceptanceCriteria?: string[];
}

/**
 * Coordinator — assigns work, enforces budgets/timeouts/retry limits, detects
 * conflicting concurrent work, runs tests and independent review, and prepares
 * PRs. Human approval gates stay on the consequential steps (external writes,
 * merge, release) regardless of autonomy level.
 */
export class CoordinatorService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly tasks: TaskService,
    private readonly runs: RunService,
    private readonly providers: ProviderService,
    private readonly registry: RegistryService,
  ) {}

  // ---- Assignment ----------------------------------------------------------

  recommend(taskId: string): { task: Task; requirements: ReturnType<typeof inferRequirements>; recommendations: ProviderRecommendation[] } | { error: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { error: 'Task not found' };
    const requirements = inferRequirements(task);
    const recommendations = recommendProviders(requirements, this.providers.list());
    return { task, requirements, recommendations };
  }

  /**
   * Prepare an assignment: validates dependencies and conflicts, applies the
   * project agent policy, and records the chosen provider/repo/budget.
   */
  assign(input: AssignInput, actor: string): { ok: boolean; error?: string; task?: Task; warnings: string[] } {
    const task = this.tasks.get(input.taskId);
    if (!task) return { ok: false, error: 'Task not found', warnings: [] };
    const warnings: string[] = [];

    if (input.acceptanceCriteria && input.acceptanceCriteria.length > 0) {
      this.tasks.update(task.id, { acceptanceCriteria: input.acceptanceCriteria }, actor);
    }
    if (input.repoId) {
      this.tasks.update(task.id, { repoId: input.repoId }, actor);
    }

    if (input.providerId) {
      const provider = this.providers.get(input.providerId);
      if (!provider) return { ok: false, error: 'Provider not found', warnings };
      if (!provider.enabled) return { ok: false, error: `Provider "${provider.name}" is disabled`, warnings };
      if (provider.status !== 'verified') {
        warnings.push(`Provider "${provider.name}" is ${provider.status} — runs may fail honestly until its execution path is verified`);
      }
    }

    const repoId = input.repoId ?? task.repoId;
    if (repoId) {
      const policy = this.projectPolicy(task.projectId);
      if (policy && input.providerId && policy.allowedProviders.length > 0 && !policy.allowedProviders.includes(this.providers.get(input.providerId)?.key ?? '')) {
        return { ok: false, error: 'Provider is not in this project\'s allowedProviders policy', warnings };
      }
    }

    this.audit.record({
      actor, action: 'coordinator.assign', targetKind: 'task', targetId: task.id, outcome: 'ok',
      detail: `provider=${input.providerId ?? 'unspecified'} repo=${repoId ?? 'unspecified'}`,
      data: { warnings },
    });
    return { ok: true, task: this.tasks.get(task.id), warnings };
  }

  private projectPolicy(projectId: string | null): { allowedProviders: string[]; maxRunMinutes: number; maxRetries: number; autonomyLevel: number; allowUnattendedWrites: boolean } | null {
    if (!projectId) return null;
    const row = this.db.queryOne<{ agent_policy: string }>('SELECT agent_policy FROM projects WHERE id = ?', projectId);
    if (!row) return null;
    try {
      return JSON.parse(row.agent_policy);
    } catch {
      return null;
    }
  }

  // ---- Conflict detection --------------------------------------------------

  /**
   * "Parallel agents cannot silently overwrite one another's work."
   * Worktree isolation handles physical writes; this handles logical conflicts:
   *  - a second active run on the same task
   *  - active runs on the same repository whose changed files intersect
   */
  checkConflicts(opts: { taskId?: string | null; repoId?: string | null; files?: string[] }): ConflictCheck {
    const conflicts: ConflictCheck['conflicts'] = [];
    const active = this.db.query<Record<string, unknown>>(`SELECT * FROM runs WHERE status IN ('queued','running')`).map((r) => ({
      id: String(r.id),
      taskId: (r.task_id as string) ?? null,
      repoId: (r.repo_id as string) ?? null,
      changedFiles: JSON.parse(String(r.changed_files ?? '[]')) as string[],
    }));

    for (const run of active) {
      if (opts.taskId && run.taskId === opts.taskId) {
        conflicts.push({ code: 'active-run-same-task', message: `Task already has an active run (${run.id})`, runId: run.id });
      }
      if (opts.repoId && run.repoId === opts.repoId && opts.files && opts.files.length > 0 && run.changedFiles.length > 0) {
        const overlap = run.changedFiles.filter((f) => opts.files!.some((o) => f === o || f.includes(o) || o.includes(f)));
        if (overlap.length > 0) {
          conflicts.push({ code: 'overlapping-files', message: `Active run ${run.id} is touching overlapping files: ${overlap.slice(0, 5).join(', ')}`, runId: run.id });
        }
      }
    }
    return { ok: conflicts.length === 0, conflicts };
  }

  // ---- Pipeline steps ------------------------------------------------------

  /**
   * Start an implementation run with guards:
   * conflict check → dependency check → policy check → run start (isolated worktree).
   */
  async startGuardedRun(opts: {
    taskId: string | null;
    providerId: string;
    repoId?: string | null;
    stage?: Run['stage'];
    budgetSeconds?: number;
    maxAttempts?: number;
    files?: string[];
  }, actor: string): Promise<{ ok: boolean; run?: Run; error?: string; warnings: string[] }> {
    const warnings: string[] = [];

    const conflicts = this.checkConflicts({ taskId: opts.taskId, repoId: opts.repoId, files: opts.files });
    if (!conflicts.ok) {
      const blocking = conflicts.conflicts.filter((c) => c.code === 'active-run-same-task');
      if (blocking.length > 0) {
        return { ok: false, error: `Conflicting work prevented: ${blocking[0].message}`, warnings };
      }
      for (const c of conflicts.conflicts) warnings.push(c.message);
    }

    if (opts.taskId && opts.stage && ['implementation', 'testing', 'review', 'pr_preparation'].includes(opts.stage)) {
      const unmet = this.tasks.unmetDependencies(opts.taskId);
      if (unmet.length > 0) {
        return {
          ok: false,
          error: `Blocked by unmet dependencies: ${unmet.map((d) => `${d.dependsOnTitle} [${d.dependsOnStatus}]`).join('; ')}`,
          warnings,
        };
      }
    }

    const started = await this.runs.start({
      taskId: opts.taskId,
      providerId: opts.providerId,
      repoId: opts.repoId ?? null,
      stage: opts.stage ?? 'implementation',
      budgetSeconds: opts.budgetSeconds,
      maxAttempts: opts.maxAttempts ?? 1,
    }, actor);
    if (!started.ok) return { ok: false, error: started.error, warnings };

    this.audit.record({
      actor, action: 'coordinator.start_run', targetKind: 'run', targetId: started.run?.id ?? null,
      outcome: 'ok', detail: `stage=${opts.stage ?? 'implementation'} warnings=${warnings.length}`,
      data: { warnings },
    });
    return { ok: true, run: started.run, warnings };
  }

  /**
   * Execute the project's configured checks inside the run worktree and map
   * the output to acceptance criteria as evidence.
   */
  async runTests(runId: string, commandOverride?: string): Promise<{ ok: boolean; summary: string; output: string | null; error?: string }> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, summary: 'run not found', output: null, error: 'Run not found' };
    const workDir = run.worktreePath ?? (run.repoId ? String(this.db.queryOne<{ local_path: string }>('SELECT local_path FROM repositories WHERE id = ?', run.repoId)?.local_path ?? '') : '');
    if (!workDir) return { ok: false, summary: 'no workspace', output: null, error: 'Run has no worktree or repository' };

    const projectRow = run.taskId
      ? this.db.queryOne<{ test_command: string | null }>(
          'SELECT p.test_command FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?',
          run.taskId,
        )
      : undefined;
    const command = commandOverride ?? projectRow?.test_command ?? null;
    if (!command) {
      const summary = 'No test command configured for this project — tests not run (recorded as unknown, not passing)';
      this.runs.addEvent(runId, 'warn', summary);
      return { ok: false, summary, output: null, error: 'no test command configured' };
    }

    this.runs.addEvent(runId, 'command', `test command: ${command}`);
    const output = await this.execIn(workDir, command, Math.min(run.budgetSeconds, 600));
    const preview = truncateEvidencePreview(output.stdout + (output.stderr ? `\n[stderr]\n${output.stderr}` : ''));
    const passed = output.exitCode === 0;

    this.tasks.addEvidence({
      taskId: run.taskId ?? null,
      runId: run.id,
      kind: 'test_output',
      summary: passed ? `Tests passed (exit 0): ${command}` : `Tests failed (exit ${output.exitCode}): ${command}`,
      content: preview,
      source: 'command',
    });
    if (run.taskId) {
      this.tasks.setExternalStatus(run.taskId, 'test', passed ? 'passing' : 'failing', 'coordinator:tests');
    }
    this.runs.addEvent(runId, 'evidence', passed ? 'Test execution succeeded' : 'Test execution failed — visible as failing, not hidden');

    return {
      ok: passed,
      summary: passed ? 'tests passed' : 'tests failed',
      output: preview,
      error: passed ? undefined : `exit code ${output.exitCode}`,
    };
  }

  private execIn(dir: string, command: string, timeoutSeconds: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve) => {
      const shell = process.platform === 'win32' ? 'cmd' : 'sh';
      const args = process.platform === 'win32' ? ['/c', command] : ['-c', command];
      execFile(shell, args, { cwd: dir, timeout: timeoutSeconds * 1000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        const exitCode = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code ?? 1) : err ? 1 : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
      });
    });
  }

  /**
   * Independent review of a run's changes: gathers the diff from the worktree
   * and applies the rule-based reviewer (LLM review hooks in later).
   */
  async review(runId: string): Promise<{ ok: boolean; verdict?: string; report?: ReturnType<typeof reviewChanges>; error?: string }> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: 'Run not found' };
    const workDir = run.worktreePath;
    if (!workDir) return { ok: false, error: 'Run has no worktree to review (nothing was implemented)' };

    const diff = await this.execIn(workDir, 'git diff HEAD', 60);
    const untracked = await this.execIn(workDir, 'git ls-files --others --exclude-standard', 30);
    const changedFiles = [...run.changedFiles, ...untracked.stdout.split('\n').filter(Boolean)];

    const evidence = run.taskId ? this.tasks.listEvidence(run.taskId) : [];
    const task = run.taskId ? this.tasks.get(run.taskId) : undefined;

    const report = reviewChanges({
      changedFiles,
      diffText: diff.stdout + diff.stderr,
      acceptanceCriteria: task?.acceptanceCriteria ?? [],
      evidenceSummaries: evidence.map((e) => e.summary),
      testOutput: evidence.find((e) => e.kind === 'test_output')?.contentPreview ?? null,
    });

    this.runs.setReviewVerdict(runId, report.verdict, report.summary);
    this.tasks.addEvidence({
      taskId: run.taskId ?? null,
      runId: run.id,
      kind: 'note',
      summary: `Independent review: ${report.verdict} — ${report.summary}`,
      content: truncateEvidencePreview(report.findings.map((f) => `[${f.severity}] ${f.code}: ${f.message}`).join('\n')),
      source: 'inferred',
    });
    if (run.taskId) {
      this.tasks.setExternalStatus(run.taskId, 'pr', report.verdict === 'request_changes' ? 'failing' : 'draft', 'coordinator:review');
    }
    return { ok: true, verdict: report.verdict, report };
  }

  /**
   * Prepare a PR (draft body with evidence + criteria coverage). Creating the
   * real PR is an external write — an approval request is raised and the
   * execution happens only after approval (see github.createPullRequest).
   */
  preparePr(runId: string): { ok: boolean; preparationId?: string; title?: string; body?: string; approvalId?: string; error?: string } {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: 'Run not found' };
    const task = run.taskId ? this.tasks.get(run.taskId) : undefined;

    const evidence = run.taskId ? this.tasks.listEvidence(run.taskId) : [];
    const criteriaCoverage = run.taskId ? this.tasks.criteriaCoverage(run.taskId) : [];
    const title = (task ? `Task ${task.id.slice(0, 8)}: ${task.title}` : `Run ${run.id}`).slice(0, 120);

    const body = buildPrDraftBody({
      title,
      taskId: task?.id ?? run.id,
      taskTitle: task?.title ?? '(untitled task)',
      branch: run.branchName,
      changedFiles: run.changedFiles,
      evidenceSummaries: evidence.slice(0, 10).map((e) => e.summary),
      acceptanceCriteria: criteriaCoverage,
      reviewVerdict: run.reviewVerdict,
      riskNotes: run.reviewVerdict === 'request_changes'
        ? ['Independent review requested changes — resolve before merge.']
        : run.reviewVerdict === null
          ? ['Independent review has not run yet.']
          : [],
    });

    const id = newId('prp');
    this.db.run(
      `INSERT INTO pr_preparations (id, run_id, task_id, title, body, status, created_at) VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
      id, run.id, run.taskId, title, body, nowIso(),
    );

    // External write gate: creating the PR requires explicit approval.
    const approvalPayload = { preparationId: id, runId: run.id, taskId: run.taskId, title, body: body.slice(0, 2000) };
    this.audit.record({
      actor: 'coordinator', action: 'pr.prepare', targetKind: 'run', targetId: run.id, outcome: 'ok',
      detail: `PR prepared: ${title}`,
    });
    const approvalId = this.insertApproval('github_write', `Create pull request: ${title.slice(0, 80)}`, approvalPayload);
    return { ok: true, preparationId: id, title, body, approvalId };
  }

  private insertApproval(kind: string, title: string, payload: Record<string, unknown>): string {
    const id = newId('apr');
    this.db.run(
      `INSERT INTO approvals (id, kind, title, payload, status, requested_by, created_at) VALUES (?, ?, ?, ?, 'pending', 'coordinator', ?)`,
      id, kind, title, JSON.stringify(payload), nowIso(),
    );
    return id;
  }

  // ---- Housekeeping --------------------------------------------------------

  enforceBudgets(): { timedOut: number } {
    const timedOut = this.runs.enforceTimeouts();
    return { timedOut };
  }

  listPreparations(): Array<Record<string, unknown>> {
    return this.db.query('SELECT * FROM pr_preparations ORDER BY created_at DESC');
  }

  recordFinding(input: { taskId?: string | null; runId?: string | null; stage: string; kind: string; summary: string; detail?: string | null; confidence?: string }): void {
    this.db.run(
      `INSERT INTO brain_findings (id, task_id, run_id, stage, kind, summary, detail, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('fnd'), input.taskId ?? null, input.runId ?? null, input.stage, input.kind,
      redact(input.summary).redacted, input.detail ? redact(input.detail).redacted : null,
      input.confidence ?? 'confirmed', nowIso(),
    );
  }

  listFindings(taskId: string): Array<Record<string, unknown>> {
    return this.db.query('SELECT * FROM brain_findings WHERE task_id = ? ORDER BY created_at DESC', taskId);
  }
}

export type { Provider, Task };
