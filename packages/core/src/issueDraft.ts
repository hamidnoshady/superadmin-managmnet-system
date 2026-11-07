/**
 * Evidence-backed GitHub issue draft templates.
 *
 * Product principle: issue drafts must carry context, impact, reproduction
 * steps, expected/actual behavior, evidence, acceptance criteria,
 * implementation plan, and test requirements (issue #1 §4).
 */

export interface IssueDraftInput {
  title: string;
  context?: string;
  impact?: string;
  reproductionSteps?: string[];
  expectedBehavior?: string;
  actualBehavior?: string;
  evidence?: Array<{ summary: string; ref?: string | null }>;
  acceptanceCriteria?: string[];
  implementationPlan?: string[];
  testRequirements?: string[];
  sourceNote?: string;
  labels?: string[];
}

export function buildIssueDraftBody(input: IssueDraftInput): string {
  const lines: string[] = [];

  lines.push('## Context');
  lines.push(input.context?.trim() || '_(to be filled)_');
  lines.push('');

  lines.push('## Impact');
  lines.push(input.impact?.trim() || '_(to be filled)_');
  lines.push('');

  lines.push('## Reproduction steps');
  if (input.reproductionSteps && input.reproductionSteps.length > 0) {
    input.reproductionSteps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  } else {
    lines.push('1. _(to be filled)_');
  }
  lines.push('');

  lines.push('## Expected behavior');
  lines.push(input.expectedBehavior?.trim() || '_(to be filled)_');
  lines.push('');

  lines.push('## Actual behavior');
  lines.push(input.actualBehavior?.trim() || '_(to be filled)_');
  lines.push('');

  lines.push('## Evidence');
  if (input.evidence && input.evidence.length > 0) {
    for (const ev of input.evidence) {
      lines.push(`- ${ev.summary}${ev.ref ? ` (ref: ${ev.ref})` : ''}`);
    }
  } else {
    lines.push('- _(none attached yet — add evidence before marking the related task Completed)_');
  }
  lines.push('');

  lines.push('## Acceptance criteria');
  if (input.acceptanceCriteria && input.acceptanceCriteria.length > 0) {
    input.acceptanceCriteria.forEach((c) => lines.push(`- [ ] ${c}`));
  } else {
    lines.push('- [ ] _(to be filled)_');
  }
  lines.push('');

  lines.push('## Implementation plan');
  if (input.implementationPlan && input.implementationPlan.length > 0) {
    input.implementationPlan.forEach((s) => lines.push(`- ${s}`));
  } else {
    lines.push('- _(planning stage pending)_');
  }
  lines.push('');

  lines.push('## Test requirements');
  if (input.testRequirements && input.testRequirements.length > 0) {
    input.testRequirements.forEach((s) => lines.push(`- ${s}`));
  } else {
    lines.push('- _(to be filled)_');
  }

  if (input.sourceNote) {
    lines.push('');
    lines.push('---');
    lines.push(input.sourceNote);
  }

  return lines.join('\n');
}

export interface PrDraftInput {
  title: string;
  taskId: string;
  taskTitle: string;
  branch: string | null;
  changedFiles: string[];
  evidenceSummaries: string[];
  acceptanceCriteria: Array<{ criterion: string; covered: boolean; evidenceIds: string[] }>;
  reviewVerdict: string | null;
  riskNotes: string[];
}

export function buildPrDraftBody(input: PrDraftInput): string {
  const lines: string[] = [];
  lines.push('## Summary');
  lines.push(`Task: ${input.taskTitle} (\`${input.taskId}\`)`);
  if (input.branch) lines.push(`Branch: \`${input.branch}\``);
  lines.push('');

  lines.push('## Changed files');
  if (input.changedFiles.length > 0) {
    lines.push('```');
    input.changedFiles.forEach((f) => lines.push(f));
    lines.push('```');
  } else {
    lines.push('_(no changed files recorded)_');
  }
  lines.push('');

  lines.push('## Evidence');
  if (input.evidenceSummaries.length > 0) {
    input.evidenceSummaries.forEach((e) => lines.push(`- ${e}`));
  } else {
    lines.push('- _(none — attach evidence before merge)_');
  }
  lines.push('');

  lines.push('## Acceptance criteria coverage');
  input.acceptanceCriteria.forEach((c) => {
    lines.push(`- [${c.covered ? 'x' : ' '}] ${c.criterion}${c.evidenceIds.length > 0 ? ` — evidence: ${c.evidenceIds.join(', ')}` : ''}`);
  });
  if (input.acceptanceCriteria.length === 0) lines.push('- _(no criteria recorded)_');
  lines.push('');

  lines.push('## Review');
  lines.push(`Independent review verdict: **${input.reviewVerdict ?? 'not run'}**`);
  if (input.riskNotes.length > 0) {
    lines.push('');
    lines.push('Risk notes:');
    input.riskNotes.forEach((r) => lines.push(`- ${r}`));
  }
  lines.push('');
  lines.push('> Merge is human-approved. This PR was prepared by the Command Center with evidence from run history.');

  return lines.join('\n');
}
