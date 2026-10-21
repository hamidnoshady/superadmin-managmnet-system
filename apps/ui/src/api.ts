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
};

export interface AppSettings {
  scanRoots: string[];
  approvalPolicy: { required: ApprovalKind[]; expireHours: number };
  redactionEnabled: boolean;
  staleAfterMinutes: number;
  githubMode: string;
  notes: Record<string, string>;
}
