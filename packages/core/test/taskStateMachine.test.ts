import { describe, expect, it } from 'vitest';
import {
  allowedNextStatuses,
  canTransition,
  validateTransition,
  isTerminal,
} from '../src/taskStateMachine.js';

describe('task state machine', () => {
  it('follows the happy path Incoming -> ... -> Completed', () => {
    const path = [
      ['Incoming', 'Triage'],
      ['Triage', 'Investigating'],
      ['Investigating', 'Planned'],
      ['Planned', 'Waiting for Approval'],
      ['Waiting for Approval', 'Approved'],
      ['Approved', 'In Development'],
      ['In Development', 'Testing'],
      ['Testing', 'Review'],
      ['Review', 'Ready for Merge'],
    ] as const;
    for (const [from, to] of path) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it('refuses skipping into Completed without evidence', () => {
    const result = validateTransition('Ready for Merge', 'Completed', []);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/evidence/i);
  });

  it('allows Completed with evidence', () => {
    const result = validateTransition('Ready for Merge', 'Completed', [{ id: 'e1' }]);
    expect(result.ok).toBe(true);
  });

  it('refuses impossible transitions', () => {
    expect(canTransition('Completed', 'In Development')).toBe(false);
    expect(canTransition('Incoming', 'Completed')).toBe(false);
    expect(canTransition('Cancelled', 'Review')).toBe(false);
  });

  it('lets reality interrupt: any active state can become Blocked/Failed', () => {
    expect(canTransition('In Development', 'Blocked')).toBe(true);
    expect(canTransition('Testing', 'Failed')).toBe(true);
    expect(canTransition('Blocked', 'In Development')).toBe(true);
    expect(canTransition('Failed', 'Investigating')).toBe(true);
  });

  it('rejects unknown statuses', () => {
    const result = validateTransition('Incoming', 'Yolo' as never, []);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Unknown status/);
  });

  it('lists allowed next statuses', () => {
    expect(allowedNextStatuses('Review')).toContain('Ready for Merge');
    expect(isTerminal('Completed')).toBe(true);
    expect(isTerminal('Blocked')).toBe(false);
  });

  it('rejects self-transitions', () => {
    expect(validateTransition('Blocked', 'Blocked', []).ok).toBe(false);
  });
});
