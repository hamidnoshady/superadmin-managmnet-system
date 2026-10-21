import type { ApprovalKind } from './types.js';

/**
 * Approval policy.
 *
 * Product principle: "Approval gates for external writes, destructive
 * operations, merging, releases, and deployments by default." Relaxing any
 * gate is itself a consequential (audited) action.
 */

export interface ApprovalPolicy {
  /** Kinds that require an approved request before execution. */
  required: ApprovalKind[];
  /** When true, approval requests auto-expire after this many hours. */
  expireHours: number;
}

export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  required: [
    'github_write',
    'issue_create',
    'issue_close',
    'issue_comment',
    'merge',
    'release',
    'deploy',
    'branch_switch',
    'git_destructive',
    'external_write',
    'llm_send',
    'policy_change',
  ],
  expireHours: 72,
};

export const APPROVAL_KIND_LABELS: Record<ApprovalKind, string> = {
  github_write: 'Write to GitHub',
  issue_create: 'Create GitHub issue',
  issue_close: 'Close GitHub issue',
  issue_comment: 'Comment on GitHub',
  merge: 'Merge pull request',
  release: 'Create release',
  deploy: 'Deploy',
  branch_switch: 'Switch branch',
  git_destructive: 'Destructive Git command (reset/clean/force-push)',
  external_write: 'External write (any other system)',
  llm_send: 'Send content to external LLM provider',
  policy_change: 'Change security/approval policy',
};

export type ApprovalDecision =
  | { ok: true }
  | { ok: false; reason: string; requiresApproval: true };

export function checkApproval(
  policy: ApprovalPolicy,
  kind: ApprovalKind,
  opts: { approved?: boolean; now?: Date; requestedAt?: string | null } = {},
): ApprovalDecision {
  if (!policy.required.includes(kind)) {
    return { ok: true };
  }
  if (opts.approved) {
    if (opts.requestedAt && policy.expireHours > 0) {
      const ageMs = (opts.now ?? new Date()).getTime() - new Date(opts.requestedAt).getTime();
      if (ageMs > policy.expireHours * 3_600_000) {
        return {
          ok: false,
          requiresApproval: true,
          reason: `Approval for "${APPROVAL_KIND_LABELS[kind]}" has expired (${policy.expireHours}h policy) — request a fresh approval`,
        };
      }
    }
    return { ok: true };
  }
  return {
    ok: false,
    requiresApproval: true,
    reason: `"${APPROVAL_KIND_LABELS[kind]}" requires explicit owner approval before execution`,
  };
}

export function isPolicyFullyLocked(policy: ApprovalPolicy): boolean {
  return APPROVAL_KIND_LIST.every((kind) => policy.required.includes(kind));
}

export const APPROVAL_KIND_LIST = Object.keys(APPROVAL_KIND_LABELS) as ApprovalKind[];
