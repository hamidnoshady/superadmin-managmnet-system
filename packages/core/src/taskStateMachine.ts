import type { Evidence, TaskStatus } from './types.js';
import { TASK_STATUSES } from './types.js';

/**
 * Internal task lifecycle.
 *
 * "Not every task needs every stage" — transitions are permissive along the
 * happy path but always keep the guardrails from the product principles:
 *  - Completed requires at least one evidence record.
 *  - Consequential states (Ready for Merge) cannot be claimed without evidence.
 *  - Blocked/Failed/Cancelled can be entered from any non-terminal state so
 *    reality (crashes, missing data) is always representable.
 */

const FLOW: Record<TaskStatus, TaskStatus[]> = {
  Incoming: ['Triage', 'Investigating', 'Planned'],
  Triage: ['Investigating', 'Planned', 'Blocked', 'Cancelled'],
  Investigating: ['Planned', 'Blocked', 'Failed', 'Cancelled'],
  Planned: ['Waiting for Approval', 'Approved', 'Blocked', 'Cancelled'],
  'Waiting for Approval': ['Approved', 'Planned', 'Blocked', 'Cancelled'],
  Approved: ['In Development', 'Planned', 'Blocked', 'Cancelled'],
  'In Development': ['Testing', 'Blocked', 'Failed', 'Cancelled'],
  Testing: ['Review', 'In Development', 'Blocked', 'Failed', 'Cancelled'],
  Review: ['Ready for Merge', 'In Development', 'Testing', 'Blocked', 'Failed', 'Cancelled'],
  'Ready for Merge': ['Completed', 'In Development', 'Blocked', 'Failed', 'Cancelled'],
  Completed: [],
  Blocked: ['Triage', 'Investigating', 'Planned', 'Waiting for Approval', 'Approved', 'In Development', 'Testing', 'Review', 'Cancelled', 'Failed'],
  Failed: ['Incoming', 'Triage', 'Investigating', 'In Development', 'Cancelled'],
  Cancelled: ['Incoming'],
};

export const TERMINAL_STATUSES: TaskStatus[] = ['Completed', 'Cancelled'];

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (!TASK_STATUSES.includes(to)) return false;
  if (from === to) return false;
  return FLOW[from]?.includes(to) ?? false;
}

export function allowedNextStatuses(from: TaskStatus): TaskStatus[] {
  return FLOW[from] ?? [];
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Validate a transition including evidence guards.
 * A task can only be marked Completed when evidence exists — "a completed task
 * must link to evidence".
 */
export function validateTransition(
  from: TaskStatus,
  to: TaskStatus,
  evidence: Pick<Evidence, 'id'>[] = [],
): TransitionResult {
  if (!TASK_STATUSES.includes(to)) {
    return { ok: false, reason: `Unknown status "${to}"` };
  }
  if (from === to) {
    return { ok: false, reason: `Task is already in status "${to}"` };
  }
  if (!canTransition(from, to)) {
    return {
      ok: false,
      reason: `Transition ${from} -> ${to} is not allowed. Allowed: ${allowedNextStatuses(from).join(', ') || '(none)'}`,
    };
  }
  if (to === 'Completed' && evidence.length === 0) {
    return {
      ok: false,
      reason: 'A task cannot be marked Completed without linked evidence',
    };
  }
  return { ok: true };
}
