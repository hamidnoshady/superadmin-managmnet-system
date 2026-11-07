import { describe, expect, it } from 'vitest';
import { scoreDuplicates, DUPLICATE_THRESHOLDS } from '../src/duplicate.js';

describe('duplicate detection (advisory)', () => {
  const candidates = [
    {
      kind: 'support_report' as const,
      refId: 'sr-1',
      title: 'Installation fails during update on Windows 11',
      body: 'The installer stops with error 0x80070005 when applying the update package.',
    },
    {
      kind: 'github_issue' as const,
      refId: 'gh-42',
      title: 'Remote assistance connection drops',
      body: 'Remote assistance session ends unexpectedly after 30 seconds.',
    },
  ];

  it('scores near-identical reports as likely duplicates', () => {
    const results = scoreDuplicates(
      'Installation fails during update on Windows 11',
      'The installer stops with error 0x80070005 when applying the update package.',
      candidates,
    );
    expect(results[0].refId).toBe('sr-1');
    expect(results[0].score).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLDS.likely);
    expect(results[0].rationale).toMatch(/Likely duplicate/);
  });

  it('returns unrelated candidates below threshold (never a false "sure")', () => {
    const results = scoreDuplicates(
      'Dashboard chart colors are wrong',
      'The pie chart on the analytics dashboard renders blue instead of green.',
      candidates,
    );
    for (const r of results) {
      expect(r.score).toBeLessThan(DUPLICATE_THRESHOLDS.likely);
    }
  });

  it('is advisory only: it ranks and explains but never discards', () => {
    const results = scoreDuplicates('update installation error', 'installer update failure windows', candidates);
    expect(Array.isArray(results)).toBe(true);
    for (const r of results) {
      expect(typeof r.rationale).toBe('string');
      expect(r.rationale.length).toBeGreaterThan(0);
    }
  });

  it('handles empty inputs safely', () => {
    expect(scoreDuplicates('', '', [])).toEqual([]);
    expect(scoreDuplicates('title only', '', candidates)).toBeTypeOf('object');
  });
});
