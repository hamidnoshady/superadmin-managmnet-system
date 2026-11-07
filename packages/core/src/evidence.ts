import type { Evidence } from './types.js';

/**
 * Evidence ↔ acceptance-criteria mapping.
 *
 * Product principle: "Every completed task has verifiable evidence mapped to
 * its acceptance criteria." Mapping is advisory (keyword based) but the
 * requirement for at least one evidence record before completion is enforced
 * by the state machine.
 */

export interface CriteriaCoverage {
  criterion: string;
  evidenceIds: string[];
  covered: boolean;
}

export function mapEvidenceToCriteria(
  criteria: string[],
  evidence: Pick<Evidence, 'id' | 'summary' | 'contentPreview' | 'kind'>[],
): CriteriaCoverage[] {
  return criteria.map((criterion) => {
    const terms = criterion
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4);

    const evidenceIds = evidence
      .filter((ev) => {
        const haystack = `${ev.summary} ${ev.contentPreview ?? ''} ${ev.kind}`.toLowerCase();
        return terms.some((term) => haystack.includes(term));
      })
      .map((ev) => ev.id);

    return { criterion, evidenceIds, covered: evidenceIds.length > 0 };
  });
}

export function isFullyEvidenced(criteria: string[], evidence: Pick<Evidence, 'id' | 'summary' | 'contentPreview' | 'kind'>[]): boolean {
  if (criteria.length === 0) return evidence.length > 0;
  return mapEvidenceToCriteria(criteria, evidence).every((c) => c.covered);
}

/** Content stored in evidence records is capped and must never hold secrets. */
export const EVIDENCE_PREVIEW_LIMIT = 4_000;

export function truncateEvidencePreview(text: string): string {
  if (text.length <= EVIDENCE_PREVIEW_LIMIT) return text;
  return `${text.slice(0, EVIDENCE_PREVIEW_LIMIT)}\n…[truncated]`;
}
