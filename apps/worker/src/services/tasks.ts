import type {
  Evidence,
  EvidenceKind,
  EvidenceSource,
  ExternalStatus,
  Severity,
  Task,
  TaskSource,
  TaskStatus,
} from '@dcc/core';
import {
  allowedNextStatuses,
  mapEvidenceToCriteria,
  truncateEvidencePreview,
  validateTransition,
} from '@dcc/core';
import { Database, newId, nowIso } from '../db/database.js';
import type { AuditService } from './audit.js';

export interface TaskTransitionResult {
  ok: boolean;
  task?: Task;
  error?: string;
  allowed?: TaskStatus[];
}

export class TaskService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  list(filter: { status?: TaskStatus; projectId?: string; repoId?: string } = {}): Task[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status) { clauses.push('internal_status = ?'); params.push(filter.status); }
    if (filter.projectId) { clauses.push('project_id = ?'); params.push(filter.projectId); }
    if (filter.repoId) { clauses.push('repo_id = ?'); params.push(filter.repoId); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.query<Record<string, unknown>>(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC`, ...params).map(toTask);
  }

  get(id: string): Task | undefined {
    const row = this.db.queryOne<Record<string, unknown>>('SELECT * FROM tasks WHERE id = ?', id);
    return row ? toTask(row) : undefined;
  }

  create(input: {
    title: string;
    description?: string;
    projectId?: string | null;
    repoId?: string | null;
    severity?: Severity;
    acceptanceCriteria?: string[];
    source?: TaskSource;
    sourceRef?: string | null;
    dueAt?: string | null;
    internalStatus?: TaskStatus;
  }, actor: string): Task {
    const now = nowIso();
    const task: Task = {
      id: newId('tsk'),
      title: input.title,
      description: input.description ?? '',
      projectId: input.projectId ?? null,
      repoId: input.repoId ?? null,
      internalStatus: input.internalStatus ?? 'Incoming',
      githubStatus: 'unknown',
      agentStatus: 'none',
      testStatus: 'unknown',
      prStatus: 'none',
      deployStatus: 'none',
      severity: input.severity ?? 'unknown',
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      source: input.source ?? 'manual',
      sourceRef: input.sourceRef ?? null,
      dueAt: input.dueAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.run(
      `INSERT INTO tasks (id, title, description, project_id, repo_id, internal_status, github_status, agent_status, test_status, pr_status, deploy_status, severity, acceptance_criteria, source, source_ref, due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id, task.title, task.description, task.projectId, task.repoId, task.internalStatus,
      task.githubStatus, task.agentStatus, task.testStatus, task.prStatus, task.deployStatus,
      task.severity, JSON.stringify(task.acceptanceCriteria), task.source, task.sourceRef,
      task.dueAt, task.createdAt, task.updatedAt,
    );
    this.audit.record({ actor, action: 'task.create', targetKind: 'task', targetId: task.id, outcome: 'ok', detail: task.title });
    return task;
  }

  update(id: string, patch: Partial<Task>, actor: string): Task | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next: Task = { ...current, ...patch, id: current.id, updatedAt: nowIso() };
    this.db.run(
      `UPDATE tasks SET title = ?, description = ?, project_id = ?, repo_id = ?, internal_status = ?, github_status = ?, agent_status = ?, test_status = ?, pr_status = ?, deploy_status = ?, severity = ?, acceptance_criteria = ?, due_at = ?, updated_at = ?
       WHERE id = ?`,
      next.title, next.description, next.projectId, next.repoId, next.internalStatus,
      next.githubStatus, next.agentStatus, next.testStatus, next.prStatus, next.deployStatus,
      next.severity, JSON.stringify(next.acceptanceCriteria), next.dueAt, next.updatedAt, id,
    );
    this.audit.record({ actor, action: 'task.update', targetKind: 'task', targetId: id, outcome: 'ok' });
    return next;
  }

  /** Update one of the *external* status tracks without touching internal state. */
  setExternalStatus(id: string, track: 'github' | 'agent' | 'test' | 'pr' | 'deploy', value: ExternalStatus, actor: string): Task | undefined {
    const column = { github: 'github_status', agent: 'agent_status', test: 'test_status', pr: 'pr_status', deploy: 'deploy_status' }[track];
    this.db.run(`UPDATE tasks SET ${column} = ?, updated_at = ? WHERE id = ?`, value, nowIso(), id);
    this.audit.record({ actor, action: `task.${track}_status`, targetKind: 'task', targetId: id, outcome: 'ok', detail: value });
    return this.get(id);
  }

  /**
   * Internal lifecycle transition — enforced by the core state machine.
   * Completion is impossible without evidence (see core/taskStateMachine).
   */
  transition(id: string, to: TaskStatus, actor: string, reason?: string): TaskTransitionResult {
    const task = this.get(id);
    if (!task) return { ok: false, error: 'Task not found' };

    const evidence = this.listEvidence(id);
    const check = validateTransition(task.internalStatus, to, evidence);
    if (!check.ok) {
      this.audit.record({
        actor, action: 'task.transition', targetKind: 'task', targetId: id,
        outcome: 'denied', detail: check.reason ?? 'Transition denied',
        data: { from: task.internalStatus, to },
      });
      return { ok: false, error: check.reason, allowed: allowedNextStatuses(task.internalStatus) };
    }

    this.db.run('UPDATE tasks SET internal_status = ?, updated_at = ? WHERE id = ?', to, nowIso(), id);
    this.audit.record({
      actor, action: 'task.transition', targetKind: 'task', targetId: id, outcome: 'ok',
      detail: `${task.internalStatus} -> ${to}${reason ? ` (${reason})` : ''}`,
      data: { from: task.internalStatus, to },
    });
    return { ok: true, task: this.get(id) };
  }

  // ---- Evidence ------------------------------------------------------------

  addEvidence(input: {
    taskId?: string | null;
    runId?: string | null;
    kind: EvidenceKind;
    summary: string;
    ref?: string | null;
    content?: string | null;
    source?: EvidenceSource;
  }): Evidence {
    const evidence: Evidence = {
      id: newId('ev'),
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      kind: input.kind,
      summary: input.summary,
      ref: input.ref ?? null,
      contentPreview: input.content ? truncateEvidencePreview(input.content) : null,
      producedAt: nowIso(),
      source: input.source ?? 'manual',
    };
    this.db.run(
      `INSERT INTO evidence (id, task_id, run_id, kind, summary, ref, content_preview, source, produced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      evidence.id, evidence.taskId, evidence.runId, evidence.kind, evidence.summary,
      evidence.ref, evidence.contentPreview, evidence.source, evidence.producedAt,
    );
    return evidence;
  }

  listEvidence(taskId: string): Evidence[] {
    return this.db
      .query<Record<string, unknown>>('SELECT * FROM evidence WHERE task_id = ? ORDER BY produced_at DESC', taskId)
      .map(toEvidence);
  }

  criteriaCoverage(taskId: string): ReturnType<typeof mapEvidenceToCriteria> {
    const task = this.get(taskId);
    if (!task) return [];
    return mapEvidenceToCriteria(task.acceptanceCriteria, this.listEvidence(taskId));
  }

  // ---- Links ---------------------------------------------------------------

  link(taskId: string, kind: string, ref: string, url: string | null, actor: string): void {
    this.db.run(
      'INSERT INTO task_links (id, task_id, kind, ref, url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      newId('lnk'), taskId, kind, ref, url, nowIso(),
    );
    this.audit.record({ actor, action: 'task.link', targetKind: 'task', targetId: taskId, outcome: 'ok', detail: `${kind}: ${ref}` });
  }

  listLinks(taskId: string): Array<{ id: string; kind: string; ref: string; url: string | null }> {
    return this.db
      .query<Record<string, unknown>>('SELECT * FROM task_links WHERE task_id = ? ORDER BY created_at DESC', taskId)
      .map((row) => ({ id: String(row.id), kind: String(row.kind), ref: String(row.ref), url: (row.url as string) ?? null }));
  }
}

function toTask(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    title: String(row.title),
    description: String(row.description ?? ''),
    projectId: (row.project_id as string) ?? null,
    repoId: (row.repo_id as string) ?? null,
    internalStatus: row.internal_status as TaskStatus,
    githubStatus: row.github_status as ExternalStatus,
    agentStatus: row.agent_status as ExternalStatus,
    testStatus: row.test_status as ExternalStatus,
    prStatus: row.pr_status as ExternalStatus,
    deployStatus: row.deploy_status as ExternalStatus,
    severity: row.severity as Severity,
    acceptanceCriteria: JSON.parse(String(row.acceptance_criteria ?? '[]')),
    source: row.source as TaskSource,
    sourceRef: (row.source_ref as string) ?? null,
    dueAt: (row.due_at as string) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toEvidence(row: Record<string, unknown>): Evidence {
  return {
    id: String(row.id),
    taskId: (row.task_id as string) ?? null,
    runId: (row.run_id as string) ?? null,
    kind: row.kind as EvidenceKind,
    summary: String(row.summary),
    ref: (row.ref as string) ?? null,
    contentPreview: (row.content_preview as string) ?? null,
    producedAt: String(row.produced_at),
    source: row.source as EvidenceSource,
  };
}
