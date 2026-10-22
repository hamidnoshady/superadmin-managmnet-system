import type { Provider, Task } from './types.js';

/**
 * Capability-based assignment recommendations.
 *
 * Product principle: "Recommendations for automatic assignment can be added
 * after reliable capability data exists." Every recommendation is inferred —
 * the owner still chooses. Unverified providers can be recommended only as
 * fallbacks and always carry their status.
 */

export interface TaskRequirements {
  needsFilesystem: boolean;
  needsTerminal: boolean;
  needsTesting: boolean;
  needsStructuredOutput: boolean;
}

export interface ProviderRecommendation {
  providerId: string;
  providerName: string;
  status: string;
  score: number;
  rationale: string;
  eligible: boolean;
}

export function inferRequirements(task: Pick<Task, 'title' | 'description' | 'acceptanceCriteria'>): TaskRequirements {
  const text = `${task.title} ${task.description} ${(task.acceptanceCriteria ?? []).join(' ')}`.toLowerCase();
  return {
    needsFilesystem: /fix|implement|refactor|code|file|module|feature|bug|patch/.test(text),
    needsTerminal: /test|build|run|command|ci|install|script/.test(text),
    needsTesting: /test|verify|regression|acceptance|evidence/.test(text),
    needsStructuredOutput: /report|issue|draft|summary|plan|document/.test(text),
  };
}

export function recommendProviders(requirements: TaskRequirements, providers: Provider[]): ProviderRecommendation[] {
  return providers
    .map((p) => {
      let score = 0;
      const reasons: string[] = [];

      if (p.enabled) { score += 10; } else { reasons.push('disabled'); }
      if (p.status === 'verified') { score += 30; reasons.push('verified execution path'); }
      else if (p.status === 'unverified') { score += 5; reasons.push('unverified — needs a connection check first'); }
      else { reasons.push(`status ${p.status} — not assignable`); }

      const caps = [
        [requirements.needsFilesystem, p.capabilities.filesystem, 'filesystem access'],
        [requirements.needsTerminal, p.capabilities.terminal, 'terminal execution'],
        [requirements.needsTesting, p.capabilities.testing, 'test execution'],
        [requirements.needsStructuredOutput, p.capabilities.structuredOutput, 'structured output'],
      ] as const;

      let matched = 0;
      let missing = 0;
      for (const [needed, has, label] of caps) {
        if (!needed) continue;
        if (has) { score += 15; matched += 1; }
        else { score -= 20; missing += 1; reasons.push(`missing ${label}`); }
      }

      const eligible = p.enabled && p.status === 'verified' && missing === 0;
      return {
        providerId: p.id,
        providerName: p.name,
        status: p.status,
        score,
        rationale: reasons.length > 0 ? reasons.join('; ') : 'capability match',
        eligible,
        matched,
      };
    })
    .sort((a, b) => (b.eligible ? 1 : 0) - (a.eligible ? 1 : 0) || b.score - a.score)
    .map(({ providerId, providerName, status, score, rationale, eligible }) => ({
      providerId, providerName, status, score, rationale, eligible,
    }));
}
