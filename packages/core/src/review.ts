/**
 * Independent review stage.
 *
 * Product principle: the review role "independently assess[es] correctness,
 * security, regressions, and whether evidence supports the conclusion."
 * This is the rule-based reviewer used until a verified LLM reviewer exists;
 * its findings are advisory and always human-visible.
 */

export type ReviewVerdict = 'approve' | 'request_changes' | 'needs_human';

export interface ReviewFinding {
  code: string;
  severity: 'blocker' | 'warning' | 'info';
  message: string;
  file?: string;
}

export interface ReviewReport {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
  summary: string;
  reviewedAt: string;
}

export interface ReviewInput {
  changedFiles: string[];
  diffText?: string;
  acceptanceCriteria?: string[];
  evidenceSummaries?: string[];
  testOutput?: string | null;
  scopeHints?: string[];
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['aws_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['generic_secret', /(?:password|secret|api[_-]?key|auth[_-]?token)\s*[=:]\s*["'][^"']{6,}["']/i],
];

const DEBUG_LEFTOVERS: Array<[string, RegExp]> = [
  ['console.log', /\bconsole\.log\s*\(/],
  ['debugger', /\bdebugger\b/],
  ['leftover TODO in changed code', /\bTODO\b|\bFIXME\b/],
];

export function reviewChanges(input: ReviewInput): ReviewReport {
  const findings: ReviewFinding[] = [];
  const diff = input.diffText ?? '';
  const files = input.changedFiles ?? [];

  // Security: secrets must never appear in a diff.
  for (const [name, pattern] of SECRET_PATTERNS) {
    const match = diff.match(pattern);
    if (match) {
      findings.push({
        code: 'secret-in-diff',
        severity: 'blocker',
        message: `Possible ${name} found in the diff — remove it before merge (${match[0].slice(0, 24)}…).`,
      });
    }
  }

  // Regression hygiene: debug leftovers.
  for (const [name, pattern] of DEBUG_LEFTOVERS) {
    const match = diff.match(pattern);
    if (match) {
      findings.push({
        code: 'debug-leftover',
        severity: 'warning',
        message: `Possible ${name} left in changed code — verify it is intentional.`,
      });
    }
  }

  // Scope: changes outside declared scope hints are flagged for a human look.
  if (input.scopeHints && input.scopeHints.length > 0) {
    const outside = files.filter((f) => !input.scopeHints!.some((hint) => f.includes(hint)));
    if (outside.length > 0 && outside.length === files.length) {
      findings.push({
        code: 'scope-drift',
        severity: 'warning',
        message: `All ${files.length} changed file(s) fall outside the planned scope (${input.scopeHints.join(', ')}).`,
      });
    }
  }

  // Evidence discipline: conclusions need evidence.
  const evidenceSummaries = input.evidenceSummaries ?? [];
  if (evidenceSummaries.length === 0) {
    findings.push({
      code: 'no-evidence',
      severity: 'blocker',
      message: 'No evidence recorded for this change — the conclusion is not supportable yet.',
    });
  }

  // Acceptance criteria: uncovered criteria block an approve verdict.
  const criteria = input.acceptanceCriteria ?? [];
  const uncovered = criteria.filter((c) => {
    const terms = c.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
    const haystack = evidenceSummaries.join(' ').toLowerCase() + ' ' + diff.toLowerCase();
    return !terms.some((t) => haystack.includes(t));
  });
  for (const c of uncovered) {
    findings.push({
      code: 'criterion-uncovered',
      severity: 'warning',
      message: `Acceptance criterion not clearly covered by evidence: "${c}"`,
    });
  }

  // Tests: if tests were required, failing/no output blocks approval.
  if (input.testOutput) {
    if (/fail(ed|ure)|\b[1-9]\d*\s+failed/i.test(input.testOutput)) {
      findings.push({
        code: 'tests-failing',
        severity: 'blocker',
        message: 'Test output reports failures — fix before requesting merge.',
      });
    }
  } else if (criteria.length > 0) {
    findings.push({
      code: 'tests-not-run',
      severity: 'warning',
      message: 'No test output attached to this change.',
    });
  }

  // Very large changes deserve a human.
  if (files.length > 30) {
    findings.push({
      code: 'large-change',
      severity: 'warning',
      message: `${files.length} files changed — recommend human review regardless of other findings.`,
    });
  }

  const blockers = findings.filter((f) => f.severity === 'blocker');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const verdict: ReviewVerdict = blockers.length > 0 ? 'request_changes' : warnings.length > 0 ? 'needs_human' : 'approve';

  return {
    verdict,
    findings,
    summary:
      verdict === 'approve'
        ? 'Rule-based review found no blockers or warnings. Human merge approval still required.'
        : verdict === 'request_changes'
          ? `${blockers.length} blocker(s) must be resolved before merge.`
          : `${warnings.length} warning(s) — human judgment needed before merge.`,
    reviewedAt: new Date().toISOString(),
  };
}
