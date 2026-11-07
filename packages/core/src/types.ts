/**
 * Shared domain types for the Development Command Center.
 *
 * Product principle: internal task state is always tracked separately from
 * GitHub issue status, agent execution status, test status, PR status and
 * deployment status. Never collapse them into a single "status" field.
 */

// ---------------------------------------------------------------------------
// Task lifecycle (internal workflow state)
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  'Incoming',
  'Triage',
  'Investigating',
  'Planned',
  'Waiting for Approval',
  'Approved',
  'In Development',
  'Testing',
  'Review',
  'Ready for Merge',
  'Completed',
  'Blocked',
  'Failed',
  'Cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** External status tracks. Kept distinct from TaskStatus on purpose. */
export type ExternalStatus = 'unknown' | 'none' | 'open' | 'closed' | 'passing' | 'failing' | 'running' | 'merged' | 'draft';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface Task {
  id: string;
  title: string;
  description: string;
  projectId: string | null;
  repoId: string | null;
  internalStatus: TaskStatus;
  githubStatus: ExternalStatus;
  agentStatus: ExternalStatus;
  testStatus: ExternalStatus;
  prStatus: ExternalStatus;
  deployStatus: ExternalStatus;
  severity: Severity;
  acceptanceCriteria: string[];
  source: TaskSource;
  sourceRef: string | null;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TaskSource = 'manual' | 'github_issue' | 'support_report' | 'agent' | 'import';

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export type EvidenceKind =
  | 'command_output'
  | 'test_output'
  | 'git_snapshot'
  | 'diff'
  | 'log'
  | 'screenshot'
  | 'link'
  | 'note';

export interface Evidence {
  id: string;
  taskId: string | null;
  runId: string | null;
  kind: EvidenceKind;
  summary: string;
  /** Storage reference (file path or URL). Never contains secrets. */
  ref: string | null;
  /** Truncated, redacted content preview. */
  contentPreview: string | null;
  producedAt: string;
  source: EvidenceSource;
}

export type EvidenceSource = 'git' | 'command' | 'github_api' | 'agent' | 'manual' | 'inferred';

// ---------------------------------------------------------------------------
// Providers (coding tools / LLM agents)
// ---------------------------------------------------------------------------

export type ProviderKind = 'cli' | 'api' | 'browser' | 'local_model';
export type ProviderStatus = 'verified' | 'unverified' | 'unavailable' | 'unknown' | 'disabled';

export interface ProviderCapabilities {
  filesystem: boolean;
  terminal: boolean;
  testing: boolean;
  structuredOutput: boolean;
  cancellation: boolean;
  costVisibility: boolean;
}

export interface Provider {
  id: string;
  key: string;
  name: string;
  kind: ProviderKind;
  executionMethod: 'api' | 'cli' | 'browser' | 'local';
  authMethod: string;
  status: ProviderStatus;
  capabilities: ProviderCapabilities;
  models: string[];
  prerequisites: string[];
  limitations: string[];
  lastCheckedAt: string | null;
  checkNotes: string | null;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Runs (agent / tool executions)
// ---------------------------------------------------------------------------

export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'interrupted';

export type RunStage =
  | 'intake'
  | 'triage'
  | 'investigation'
  | 'planning'
  | 'implementation'
  | 'testing'
  | 'review'
  | 'pr_preparation';

export interface Run {
  id: string;
  taskId: string | null;
  providerId: string | null;
  repoId: string | null;
  stage: RunStage;
  status: RunStatus;
  branchName: string | null;
  worktreePath: string | null;
  changedFiles: string[];
  exitCode: number | null;
  error: string | null;
  budgetSeconds: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** True when state was recovered after an interrupted application restart. */
  recovered: boolean;
  /** Retry chain: 1-based attempt number and optional link to the prior run. */
  attempt: number;
  maxAttempts: number;
  retryOf: string | null;
  /** Set by the independent review stage. */
  reviewVerdict: 'approve' | 'request_changes' | 'needs_human' | null;
}

export interface RunEvent {
  id: string;
  runId: string;
  at: string;
  kind: 'info' | 'warn' | 'error' | 'command' | 'status' | 'evidence';
  message: string;
  data: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Projects & repositories
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  description: string;
  rootPath: string | null;
  instructions: string;
  buildCommand: string | null;
  testCommand: string | null;
  agentPolicy: AgentPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPolicy {
  /** May agents write files without approval? */
  allowUnattendedWrites: boolean;
  /** May agents run terminal commands? */
  allowTerminal: boolean;
  maxRunMinutes: number;
  allowedProviders: string[];
  /**
   * 0 = every stage approval-gated (default)
   * 1 = automatic investigation/planning, implementation gated
   * 2 = automatic implementation in isolated worktrees, merge gated
   * 3 = unattended pipeline within budget (explicit per-project opt-in)
   */
  autonomyLevel: 0 | 1 | 2 | 3;
  /** Stages the pipeline must pass for this project (empty = all). */
  requiredStages: RunStage[];
  /** Bounded retries for failed runs. */
  maxRetries: number;
}

export interface Repository {
  id: string;
  projectId: string | null;
  name: string;
  localPath: string;
  remoteUrl: string | null;
  githubOwner: string | null;
  githubRepo: string | null;
  defaultBranch: string | null;
  /** Real Git state captured from the local checkout. */
  gitState: GitState | null;
  gitStateCapturedAt: string | null;
  gitStateError: string | null;
  lastGithubSyncAt: string | null;
  githubSyncError: string | null;
  createdAt: string;
}

export interface GitState {
  branch: string | null;
  commitSha: string | null;
  commitSubject: string | null;
  /** Uncommitted changes present — the UI must warn about this. */
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
  detached: boolean;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface GithubIssue {
  id: string;
  repoId: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  labels: string[];
  assignees: string[];
  milestone: string | null;
  author: string;
  url: string;
  updatedAt: string;
  syncedAt: string;
}

export interface GithubPullRequest {
  id: string;
  repoId: string;
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  reviewDecision: string | null;
  mergeable: string | null;
  ciStatus: string | null;
  url: string;
  updatedAt: string;
  syncedAt: string;
}

export interface IssueDraft {
  id: string;
  title: string;
  body: string;
  repoId: string | null;
  labels: string[];
  taskTitle: string;
  sourceKind: 'manual' | 'support_report';
  sourceId: string | null;
  createdAt: string;
  createdBy: string;
}

// ---------------------------------------------------------------------------
// Biza Miz support / bug reports
// ---------------------------------------------------------------------------

export type SupportChannel = 'manual' | 'api' | 'webhook' | 'browser_adapter' | 'import';

export interface SupportReport {
  id: string;
  channel: SupportChannel;
  externalRef: string | null;
  title: string;
  /** Original text as received. Never sent to LLMs or GitHub unredacted. */
  bodyRaw: string;
  /** Redacted text safe for LLM prompts and GitHub issue bodies. */
  bodyRedacted: string;
  productModule: string | null;
  appVersion: string | null;
  environment: string | null;
  /** Salted hash only — raw tenant identifiers are never stored in task data. */
  tenantRefHash: string | null;
  severity: Severity;
  status: 'new' | 'triaging' | 'linked' | 'needs_evidence' | 'resolved' | 'closed';
  triageCategory: string | null;
  triageNotes: string | null;
  duplicateOfId: string | null;
  duplicateScore: number | null;
  linkedTaskId: string | null;
  receivedAt: string;
  updatedAt: string;
}

export interface DuplicateCandidate {
  kind: 'support_report' | 'github_issue';
  refId: string;
  title: string;
  score: number;
  rationale: string;
  url: string | null;
}

// ---------------------------------------------------------------------------
// Approvals & audit
// ---------------------------------------------------------------------------

export type ApprovalKind =
  | 'github_write'
  | 'issue_create'
  | 'issue_close'
  | 'issue_comment'
  | 'merge'
  | 'release'
  | 'deploy'
  | 'branch_switch'
  | 'git_destructive'
  | 'external_write'
  | 'llm_send'
  | 'policy_change'
  | 'restore_backup';

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  title: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
  createdAt: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  targetKind: string;
  targetId: string | null;
  outcome: 'ok' | 'denied' | 'error';
  detail: string | null;
  data: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Status display (evidence-backed dashboard)
// ---------------------------------------------------------------------------

/**
 * Every status shown in the UI must carry a source and last-updated time.
 * `confirmed`  — read from a real system (Git, GitHub API, process exit code)
 * `inferred`   — recommendation/derived, not a confirmed fact
 * `stale`      — data older than the configured freshness window
 * `unavailable`— the integration could not be read; must never look like success
 */
export type StatusConfidence = 'confirmed' | 'inferred' | 'stale' | 'unavailable';

export interface SourcedStatus {
  label: string;
  value: string;
  source: string;
  updatedAt: string | null;
  confidence: StatusConfidence;
}

export interface DashboardSummary {
  generatedAt: string;
  projects: { total: number; withRepos: number };
  repositories: { total: number; dirty: number; syncErrors: number; lastRefresh: string | null };
  tasks: Record<string, number>;
  github: { openIssues: number; openPrs: number; failingCi: number; lastSync: string | null };
  support: { new: number; triaging: number; linked: number; needsEvidence: number };
  runs: { active: number; failed: number; interrupted: number };
  approvals: { pending: number };
  staleWork: number;
  providers: { verified: number; total: number };
  items: SourcedStatus[];
}
