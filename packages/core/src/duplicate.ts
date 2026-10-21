import type { DuplicateCandidate } from './types.js';

/**
 * Advisory duplicate detection.
 *
 * Product principle: "Duplicate detection is advisory and does not silently
 * discard reports." Nothing here ever auto-closes or auto-merges; it only
 * produces ranked candidates with a rationale so a human decides.
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in',
  'on', 'for', 'and', 'or', 'it', 'its', 'with', 'that', 'this', 'when', 'at',
  'by', 'from', 'as', 'not', 'no', 'but', 'if', 'then', 'than', 'so', 'we',
  'you', 'i', 'my', 'our', 'their', 'there', 'here', 'do', 'does', 'did',
  'have', 'has', 'had', 'can', 'could', 'should', 'would', 'will', 'just',
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function bigrams(text: string): Set<string> {
  const normalized = (text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const out = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    out.add(normalized.slice(i, i + 2));
  }
  return out;
}

export interface ScoredDuplicate extends DuplicateCandidate {
  /** Normalized 0..1 score. */
  score: number;
}

export interface CandidateInput {
  kind: DuplicateCandidate['kind'];
  refId: string;
  title: string;
  body?: string;
  url?: string | null;
}

export const DUPLICATE_THRESHOLDS = {
  /** Human review recommended; almost certainly the same issue. */
  likely: 0.72,
  /** Worth mentioning as related. */
  possible: 0.5,
} as const;

export function scoreDuplicates(
  title: string,
  body: string,
  candidates: CandidateInput[],
): ScoredDuplicate[] {
  const queryTokens = tokenize(`${title} ${body}`);
  const queryBigrams = bigrams(title);

  return candidates
    .map((candidate) => {
      const candTokens = tokenize(`${candidate.title} ${candidate.body ?? ''}`);
      const candBigrams = bigrams(candidate.title);
      const bodyScore = jaccard(queryTokens, candTokens);
      const titleScore = jaccard(queryBigrams, candBigrams);
      // Title similarity is weighted higher: titles are the strongest signal.
      const score = Number((titleScore * 0.6 + bodyScore * 0.4).toFixed(3));

      let rationale: string;
      if (score >= DUPLICATE_THRESHOLDS.likely) {
        rationale = 'Likely duplicate — strong title/body overlap; recommend linking instead of creating a new issue';
      } else if (score >= DUPLICATE_THRESHOLDS.possible) {
        rationale = 'Possibly related — review before creating new work';
      } else {
        rationale = 'Weak similarity';
      }

      return {
        kind: candidate.kind,
        refId: candidate.refId,
        title: candidate.title,
        score,
        rationale,
        url: candidate.url ?? null,
      };
    })
    .filter((c) => c.score >= DUPLICATE_THRESHOLDS.possible)
    .sort((a, b) => b.score - a.score);
}
