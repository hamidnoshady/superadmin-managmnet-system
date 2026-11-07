import { describe, expect, it } from 'vitest';
import { makeSourcedStatus, isStale, findStaleWork } from '../src/status.js';
import { DEFAULT_APPROVAL_POLICY, checkApproval } from '../src/approvals.js';
import { mapEvidenceToCriteria, isFullyEvidenced, truncateEvidencePreview } from '../src/evidence.js';

const NOW = new Date('2026-10-21T12:00:00Z');

describe('sourced status', () => {
  it('marks fresh confirmed data as confirmed', () => {
    const s = makeSourcedStatus({
      label: 'Git status',
      value: 'clean',
      source: 'git',
      updatedAt: '2026-10-21T11:55:00Z',
      confirmed: true,
      now: NOW,
    });
    expect(s.confidence).toBe('confirmed');
    expect(s.updatedAt).toBe('2026-10-21T11:55:00.000Z');
  });

  it('marks old confirmed data as stale', () => {
    const s = makeSourcedStatus({
      label: 'GitHub sync',
      value: '12 open issues',
      source: 'github_api',
      updatedAt: '2026-10-21T10:00:00Z',
      confirmed: true,
      staleAfterMinutes: 15,
      now: NOW,
    });
    expect(s.confidence).toBe('stale');
  });

  it('marks derived values as inferred', () => {
    const s = makeSourcedStatus({
      label: 'Recommendation',
      value: 'assign to investigation',
      source: 'inferred',
      updatedAt: '2026-10-21T11:59:00Z',
      confirmed: false,
      now: NOW,
    });
    expect(s.confidence).toBe('inferred');
  });

  it('marks unreadable integrations as unavailable — never healthy', () => {
    const s = makeSourcedStatus({
      label: 'Biza Miz API',
      value: 'connection failed',
      source: 'biza_miz',
      updatedAt: null,
      confirmed: true,
      unavailable: true,
      now: NOW,
    });
    expect(s.confidence).toBe('unavailable');
    expect(s.updatedAt).toBeNull();
  });

  it('isStale computes age correctly', () => {
    expect(isStale('2026-10-21T11:50:00Z', 15, NOW)).toBe(false);
    expect(isStale('2026-10-21T11:30:00Z', 15, NOW)).toBe(true);
  });
});

describe('stale work detection', () => {
  it('flags active work with no recent updates', () => {
    const stale = findStaleWork(
      [
        {
          id: 't1',
          kind: 'task',
          title: 'Fix installer',
          updatedAt: '2026-10-21T09:00:00Z',
          activityStatus: 'In Development',
          activeStatuses: ['In Development', 'Testing'],
        },
        {
          id: 't2',
          kind: 'task',
          title: 'Fresh work',
          updatedAt: '2026-10-21T11:58:00Z',
          activityStatus: 'In Development',
          activeStatuses: ['In Development', 'Testing'],
        },
      ],
      60,
      NOW,
    );
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe('t1');
    expect(stale[0].staleReason).toMatch(/No update/);
  });

  it('flags overdue work even outside active statuses', () => {
    const stale = findStaleWork(
      [
        {
          id: 't3',
          kind: 'task',
          title: 'Overdue review',
          updatedAt: '2026-10-21T11:59:00Z',
          activityStatus: 'Review',
          activeStatuses: ['In Development'],
          dueAt: '2026-10-20T00:00:00Z',
        },
      ],
      60,
      NOW,
    );
    expect(stale).toHaveLength(1);
    expect(stale[0].staleReason).toMatch(/due/i);
  });
});

describe('approval policy', () => {
  it('requires approval for consequential actions by default', () => {
    for (const kind of ['issue_create', 'merge', 'deploy', 'git_destructive', 'llm_send'] as const) {
      const r = checkApproval(DEFAULT_APPROVAL_POLICY, kind);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.requiresApproval).toBe(true);
    }
  });

  it('allows execution with a fresh approval', () => {
    const r = checkApproval(DEFAULT_APPROVAL_POLICY, 'issue_create', {
      approved: true,
      requestedAt: '2026-10-21T11:00:00Z',
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it('expires old approvals', () => {
    const r = checkApproval(DEFAULT_APPROVAL_POLICY, 'merge', {
      approved: true,
      requestedAt: '2026-10-01T00:00:00Z',
      now: NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/expired/i);
  });

  it('permits non-consequential actions without approval', () => {
    const relaxed = { ...DEFAULT_APPROVAL_POLICY, required: [] };
    expect(checkApproval(relaxed, 'issue_create').ok).toBe(true);
  });
});

describe('evidence mapping', () => {
  const evidence = [
    { id: 'e1', summary: 'npm test output with 42 passing tests', contentPreview: 'Test Suites: 10 passed', kind: 'test_output' as const },
    { id: 'e2', summary: 'git snapshot after fix', contentPreview: 'branch main clean', kind: 'git_snapshot' as const },
  ];

  it('maps evidence to acceptance criteria keywords', () => {
    const coverage = mapEvidenceToCriteria(
      ['Tests must pass after the fix', 'Documentation is updated'],
      evidence,
    );
    expect(coverage[0].covered).toBe(true);
    expect(coverage[0].evidenceIds).toContain('e1');
    expect(coverage[1].covered).toBe(false);
  });

  it('reports full coverage only when every criterion has evidence', () => {
    expect(isFullyEvidenced(['Tests must pass after the fix'], evidence)).toBe(true);
    expect(isFullyEvidenced(['Tests must pass', 'Docs updated'], evidence)).toBe(false);
  });

  it('truncates oversized evidence previews', () => {
    const big = 'x'.repeat(10_000);
    expect(truncateEvidencePreview(big).length).toBeLessThan(5_000);
    expect(truncateEvidencePreview('short')).toBe('short');
  });
});
