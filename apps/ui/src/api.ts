/**
 * Typed API client. All calls go to same-origin /api (proxied to the local
 * worker in dev). `X-Actor` identifies the operator in the audit log.
 */
import type {
  ApprovalKind,
  ApprovalRequest,
  AuditEntry,
  DashboardSummary,
  DuplicateCandidate,
  Evidence,
  GitState,
  GithubIssue,
  GithubPullRequest,
  Project,
  Provider,
  Repository,
  Run,
  RunEvent,
  SupportReport,
  Task,
  TaskStatus,
} from '@dcc/core';

const ACTOR_KEY = 'dcc-actor';

export function actorName(): string {
  return localStorage.getItem(ACTOR_KEY) ?? 'owner';
}

export function setActorName(name: string): void {
  localStorage.setItem(ACTOR_KEY, name);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Actor': actorName(),
      ...(options.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return data as T;
}

export const api = {
  dashboard: () => request<DashboardSummary>('/dashboard'),
  stale: () => request<Array<{ id: string; kind: string; title: string; staleReason: string; activityStatus: string }>>('/dashboard/stale'),
  search: (q: string) => request<Record<string, unknown[]>>(`/search?q=${encodeURIComponent(q)}`),
  health: () => request<{ ok: boolean; time: string }>('/health'),

  settings: () => request<AppSettings>('/settings'),
  saveSettings: (body: unknown, policyApproved = false) =>
    request<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(body), headers: policyApproved ? { 'X-Policy-Approved': '1' } : {} }),
  audit: () => request<AuditEntry[]>('/audit'),

  projects: () => request<Project[]>('/projects'),
  createProject: (body: unknown) => request<Project>('/projects', { method: 'POST', body: JSON.stringify(body) }),

  repositories: () => request<Repository[]>('/repositories'),
  registerRepository: (body: unknown) => request<{ ok: boolean; repo?: Repository; error?: string }>('/repositories', { method: 'POST', body: JSON.stringify(body) }),
  refreshRepo: (id: string) => request<{ ok: boolean; state?: GitState; error?: string }>(`/repositories/${id}/refresh`, { method: 'POST' }),
  scan: (roots?: string[]) => request<{ found: Array<{ path: string; isRegistered: boolean }>; errors: string[] }>('/scan', { method: 'POST', body: JSON.stringify(roots ? { roots } : {}) }),

  tasks: () => request<Task[]>('/tasks'),
  task: (id: string) => request<{ task: Task; evidence: Evidence[]; links: Array<{ id: string; kind: string; ref: string; url: string | null }>; criteriaCoverage: Array<{ criterion: string; evidenceIds: string[]; covered: boolean }> }>(`/tasks/${id}`),
  createTask: (body: unknown) => request<Task>('/tasks', { method: 'POST', body: JSON.stringify(body) }),
  transitionTask: (id: string, to: TaskStatus, reason?: string) =>
    request<{ ok: boolean; task?: Task; error?: string; allowed?: TaskStatus[] }>(`/tasks/${id}/transition`, { method: 'POST', body: JSON.stringify({ to, reason }) }),
  addEvidence: (id: string, body: unknown) => request<Evidence>(`/tasks/${id}/evidence`, { method: 'POST', body: JSON.stringify(body) }),

  githubAuth: () => request<{ available: boolean; method: string; notes: string; checkedAt: string }>('/github/auth'),
  githubSync: (repoId: string) => request<{ ok: boolean; issues: number; prs: number; error?: string }>('/github/sync', { method: 'POST', body: JSON.stringify({ repoId }) }),
  githubIssues: (repoId: string) => request<GithubIssue[]>(`/github/issues?repoId=${repoId}`),
  githubPulls: (repoId: string) => request<GithubPullRequest[]>(`/github/pulls?repoId=${repoId}`),
  issueDrafts: () => request<Array<{ id: string; title: string; body: string; source_kind: string; created_at: string }>>('/issue-drafts'),
  createIssueDraft: (body: unknown) => request<{ draftId: string; approval: ApprovalRequest }>('/issue-drafts', { method: 'POST', body: JSON.stringify(body) }),

  supportReports: () => request<SupportReport[]>('/support/reports'),
  createSupportReport: (body: unknown) => request<{ report: SupportReport; redactionFindings: Array<{ kind: string; count: number }> }>('/support/reports', { method: 'POST', body: JSON.stringify(body) }),
  triageReport: (id: string) => request<{ report: SupportReport; result: { category: string; severity: string; notes: string } }>(`/support/reports/${id}/triage`, { method: 'POST' }),
  reportDuplicates: (id: string) => request<DuplicateCandidate[]>(`/support/reports/${id}/duplicates`),
  reportIssueDraft: (id: string, repoId?: string | null) =>
    request<{ draftId: string; title: string; body: string; approval: ApprovalRequest }>(`/support/reports/${id}/issue-draft`, { method: 'POST', body: JSON.stringify({ repoId }) }),
  linkReportTask: (id: string, taskId: string) => request<{ ok: boolean }>(`/support/reports/${id}/link-task`, { method: 'POST', body: JSON.stringify({ taskId }) }),

  providers: () => request<Provider[]>('/providers'),
  checkProvider: (id: string) => request<Provider>(`/providers/${id}/check`, { method: 'POST' }),
  enableProvider: (id: string, enabled: boolean) => request<Provider>(`/providers/${id}/enable`, { method: 'POST', body: JSON.stringify({ enabled }) }),

  runs: () => request<Run[]>('/runs'),
  run: (id: string) => request<{ run: Run; events: RunEvent[] }>(`/runs/${id}`),
  startRun: (body: unknown) => request<{ ok: boolean; run?: Run; error?: string }>('/runs', { method: 'POST', body: JSON.stringify(body) }),
  cancelRun: (id: string) => request<{ ok: boolean; error?: string }>(`/runs/${id}/cancel`, { method: 'POST' }),

  approvals: () => request<ApprovalRequest[]>('/approvals'),
  decideApproval: (id: string, decision: 'approved' | 'rejected', reason?: string) =>
    request<{ ok: boolean; error?: string }>(`/approvals/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision, reason }) }),

  // Phase 2–4
  engineeringHealth: () => request<EngineeringHealth>('/engineering/health'),
  recommend: (taskId: string) => request<{ task: unknown; requirements: Record<string, boolean>; recommendations: Array<{ providerId: string; providerName: string; status: string; score: number; rationale: string; eligible: boolean }> }>(`/coordinator/recommend/${taskId}`),
  assign: (body: unknown) => request<{ ok: boolean; error?: string; warnings: string[] }>('/coordinator/assign', { method: 'POST', body: JSON.stringify(body) }),
  startGuardedRun: (body: unknown) => request<{ ok: boolean; run?: Run; error?: string; warnings: string[] }>('/coordinator/start', { method: 'POST', body: JSON.stringify(body) }),
  runTests: (runId: string, command?: string) => request<{ ok: boolean; summary: string; output: string | null; error?: string }>(`/coordinator/runs/${runId}/tests`, { method: 'POST', body: JSON.stringify({ command }) }),
  reviewRun: (runId: string) => request<{ ok: boolean; verdict?: string; report?: { verdict: string; findings: Array<{ code: string; severity: string; message: string }>; summary: string }; error?: string }>(`/coordinator/runs/${runId}/review`, { method: 'POST' }),
  preparePr: (runId: string) => request<{ ok: boolean; preparationId?: string; title?: string; body?: string; approvalId?: string; error?: string }>(`/coordinator/runs/${runId}/pr`, { method: 'POST' }),
  preparations: () => request<Array<{ id: string; run_id: string; task_id: string | null; title: string; body: string; status: string; pr_url: string | null; created_at: string }>>('/coordinator/preparations'),
  retryRun: (runId: string) => request<{ ok: boolean; run?: Run; error?: string }>(`/runs/${runId}/retry`, { method: 'POST' }),
  runPipeline: (body: unknown) => request<{ ok: boolean; result?: { runId: string; stages: Array<{ stage: string; status: string; note: string }>; findings: number; stoppedForApproval: boolean }; error?: string }>('/brain/pipeline', { method: 'POST', body: JSON.stringify(body) }),
  taskFindings: (taskId: string) => request<Array<{ id: string; stage: string; kind: string; summary: string; detail: string | null; confidence: string; created_at: string }>>(`/tasks/${taskId}/findings`),
  taskDependencies: (taskId: string) => request<{ dependencies: Array<{ id: string; dependsOnTaskId: string; kind: string; dependsOnTitle: string; dependsOnStatus: string }>; unmet: Array<{ dependsOnTaskId: string; dependsOnTitle: string; dependsOnStatus: string }> }>(`/tasks/${taskId}/dependencies`),
  addDependency: (taskId: string, dependsOnTaskId: string) => request<{ ok: boolean; error?: string }>(`/tasks/${taskId}/dependencies`, { method: 'POST', body: JSON.stringify({ dependsOnTaskId }) }),

  ingestConfig: () => request<{ apiUrl: string; authEnv: string; webhookSecretEnv: string }>('/ingest/biza-miz'),
  saveIngestConfig: (body: unknown) => request<unknown>('/ingest/biza-miz', { method: 'PUT', body: JSON.stringify(body) }),
  ingestCheck: () => request<{ status: string; notes: string; checkedAt: string }>('/ingest/check'),
  ingestApi: () => request<IngestResult>('/ingest/api', { method: 'POST' }),
  ingestImport: (items: unknown[], source: string) => request<IngestResult>('/ingest/import', { method: 'POST', body: JSON.stringify({ items, source }) }),
  ingestBatches: () => request<Array<{ id: string; channel: string; source: string | null; imported: number; skipped: number; errors: string; created_at: string }>>('/ingest/batches'),

  backups: () => request<Array<{ file: string; createdAt: string; sizeBytes: number; manifest: Record<string, unknown> }>>('/backups'),
  exportBackup: () => request<{ file: string; createdAt: string; sizeBytes: number; manifest: Record<string, unknown> }>('/backups/export', { method: 'POST' }),
  validateBackup: (file: string) => request<{ ok: boolean; counts?: Record<string, number>; error?: string }>('/backups/validate', { method: 'POST', body: JSON.stringify({ file }) }),
  restoreBackup: (file: string, approvalId?: string) => request<{ ok: boolean; error?: string; note?: string; requiresApproval?: boolean }>('/backups/restore', { method: 'POST', body: JSON.stringify({ file, approvalId }) }),

  openRepository: (id: string, target: 'ide' | 'terminal', approvalId?: string) =>
    request<{ ok: boolean; method: string; error?: string; requiresApproval?: boolean }>(`/repositories/${id}/open`, { method: 'POST', body: JSON.stringify({ target, approvalId }) }),
};

export interface IngestResult {
  channel: string;
  ok: boolean;
  imported: number;
  skipped: number;
  errors: string[];
  note: string;
}

export interface EngineeringHealth {
  generatedAt: string;
  cycle: { completedTasks: number; avgCycleHours: number | null; completionRate: number };
  quality: { evidenceBackedCompleted: number; evidenceCoverage: number; failingTestTasks: number; reviewApprovals: number; reviewRequestsChanges: number };
  runs: { total: number; succeeded: number; failed: number; timeout: number; interrupted: number; cancelled: number; successRate: number };
  providers: { verified: number; total: number; unverified: number };
  github: { openIssues: number; openPrs: number; lastSync: string | null; syncAgeMinutes: number | null };
  support: { open: number; avgAgeHours: number | null };
  releaseReadiness: {
    readyForMerge: number;
    releaseBlockers: Array<{ taskId: string; title: string; reason: string }>;
    ciConcerns: number;
    verdict: 'ready' | 'not-ready';
  };
  discrepancies: Array<{ taskId: string; taskTitle: string; code: string; severity: string; message: string; internalStatus: string }>;
  items: Array<{ label: string; value: string; source: string; updatedAt: string | null; confidence: string }>;
}

export interface AppSettings {
  scanRoots: string[];
  approvalPolicy: { required: ApprovalKind[]; expireHours: number };
  redactionEnabled: boolean;
  staleAfterMinutes: number;
  githubMode: string;
  notes: Record<string, string>;
}
