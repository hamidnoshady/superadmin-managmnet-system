import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Provider, ProviderCapabilities, ProviderKind, ProviderStatus } from '@dcc/core';
import { Database, newId, nowIso } from '../db/database.js';
import type { AuditService } from './audit.js';
import type { AgentAdapter } from './agentAdapters.js';

const execFileAsync = promisify(execFile);

interface ProviderSeed {
  key: string;
  name: string;
  kind: ProviderKind;
  executionMethod: Provider['executionMethod'];
  authMethod: string;
  status: ProviderStatus;
  capabilities: Partial<ProviderCapabilities>;
  models: string[];
  prerequisites: string[];
  limitations: string[];
  checkNotes: string;
}

const CAP = (c: Partial<ProviderCapabilities>): ProviderCapabilities => ({
  filesystem: false,
  terminal: false,
  testing: false,
  structuredOutput: false,
  cancellation: true,
  costVisibility: false,
  ...c,
});

/**
 * Candidate integrations from the plan. Status is NEVER claimed "verified"
 * until a real connection/execution check has passed in this environment.
 * Unknowns stay explicitly unknown ("Confirm what Freebuf refers to").
 */
const PROVIDER_SEEDS: ProviderSeed[] = [
  {
    key: 'generic-cli',
    name: 'Generic CLI Runner',
    kind: 'cli',
    executionMethod: 'cli',
    authMethod: 'local process (no credentials leave the machine)',
    status: 'verified',
    capabilities: { filesystem: true, terminal: true, testing: true, structuredOutput: true },
    models: ['git', 'shell-readonly'],
    prerequisites: ['Node.js worker process'],
    limitations: ['Read-only evidence commands by default; write commands require approval'],
    checkNotes: 'Verified: executes safe read-only commands and captures output as evidence.',
  },
  {
    key: 'github-gh-cli',
    name: 'GitHub via gh CLI',
    kind: 'cli',
    executionMethod: 'cli',
    authMethod: 'gh CLI login / GH_TOKEN',
    status: 'unverified',
    capabilities: { structuredOutput: true, cancellation: true },
    models: ['rest-v3'],
    prerequisites: ['gh CLI installed and authenticated'],
    limitations: ['Read scope recommended; write actions require approval gates'],
    checkNotes: 'Pending auth check.',
  },
  {
    key: 'claude-code',
    name: 'Claude Code',
    kind: 'cli',
    executionMethod: 'cli',
    authMethod: 'vendor login (to verify)',
    status: 'unverified',
    capabilities: { filesystem: true, terminal: true, testing: true, structuredOutput: true },
    models: ['claude-code'],
    prerequisites: ['Claude Code installed on the host', 'owner account login'],
    limitations: ['Execution/auth interface not verified in this environment', 'Cost visibility unknown'],
    checkNotes: 'Not verified: binary/login not confirmed here. Do not assign coding runs until verified.',
  },
  {
    key: 'openai-codex',
    name: 'OpenAI Codex CLI',
    kind: 'cli',
    executionMethod: 'cli',
    authMethod: 'OpenAI API key / login (to verify)',
    status: 'unverified',
    capabilities: { filesystem: true, terminal: true, testing: true, structuredOutput: true },
    models: ['codex'],
    prerequisites: ['Codex CLI installed on the host', 'API key in OS-protected storage'],
    limitations: ['Execution/auth interface not verified in this environment'],
    checkNotes: 'Not verified: binary/login not confirmed here.',
  },
  {
    key: 'arena-ai',
    name: 'Arena AI',
    kind: 'api',
    executionMethod: 'api',
    authMethod: 'API credentials (to verify)',
    status: 'unknown',
    capabilities: { structuredOutput: true },
    models: [],
    prerequisites: ['Confirmed API endpoint and credentials'],
    limitations: ['Interface not documented/verified yet'],
    checkNotes: 'Unknown: integration surface not confirmed. Adapter is a stub that refuses execution.',
  },
  {
    key: 'freebuf',
    name: 'Freebuf (identity TBD)',
    kind: 'browser',
    executionMethod: 'browser',
    authMethod: 'unknown',
    status: 'unknown',
    capabilities: {},
    models: [],
    prerequisites: ['Owner confirmation of what "Freebuf" refers to'],
    limitations: ['Identity unconfirmed per issue open-questions — adapter intentionally disabled'],
    checkNotes: 'UNKNOWN IDENTITY: no adapter implemented until the owner confirms what "Freebuf" means.',
  },
  {
    key: 'http-api-model',
    name: 'HTTP API Model (generic)',
    kind: 'api',
    executionMethod: 'api',
    authMethod: 'API key in OS-protected store',
    status: 'unverified',
    capabilities: { structuredOutput: true, costVisibility: true },
    models: ['configurable'],
    prerequisites: ['Endpoint URL + API key configured'],
    limitations: ['Cost/usage shown only when the provider API exposes it'],
    checkNotes: 'Pending configuration. Never shown as ready until a real request succeeds.',
  },
  {
    key: 'local-model',
    name: 'Local Model (Ollama-style)',
    kind: 'local_model',
    executionMethod: 'local',
    authMethod: 'none (local)',
    status: 'unavailable',
    capabilities: { structuredOutput: true },
    models: [],
    prerequisites: ['Local model server (e.g. Ollama) running on the host'],
    limitations: ['No local model server detected in this environment'],
    checkNotes: 'Unavailable: no local model server reachable.',
  },
];

export class ProviderService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly adapters: Map<string, AgentAdapter> = new Map(),
  ) {}

  ensureSeeded(): void {
    for (const seed of PROVIDER_SEEDS) {
      const existing = this.db.queryOne<{ id: string }>('SELECT id FROM providers WHERE key = ?', seed.key);
      if (existing) continue;
      this.db.run(
        `INSERT INTO providers (id, key, name, kind, execution_method, auth_method, status, capabilities, models, prerequisites, limitations, last_checked_at, check_notes, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('prv'),
        seed.key,
        seed.name,
        seed.kind,
        seed.executionMethod,
        seed.authMethod,
        seed.status,
        JSON.stringify(CAP(seed.capabilities)),
        JSON.stringify(seed.models),
        JSON.stringify(seed.prerequisites),
        JSON.stringify(seed.limitations),
        null,
        seed.checkNotes,
        seed.status === 'unknown' ? 0 : 1,
      );
    }
  }

  list(): Provider[] {
    return this.db.query<Record<string, unknown>>('SELECT * FROM providers ORDER BY name').map(toProvider);
  }

  get(id: string): Provider | undefined {
    const row = this.db.queryOne<Record<string, unknown>>('SELECT * FROM providers WHERE id = ?', id);
    return row ? toProvider(row) : undefined;
  }

  getByKey(key: string): Provider | undefined {
    const row = this.db.queryOne<Record<string, unknown>>('SELECT * FROM providers WHERE key = ?', key);
    return row ? toProvider(row) : undefined;
  }

  setEnabled(id: string, enabled: boolean, actor: string): void {
    this.db.run('UPDATE providers SET enabled = ? WHERE id = ?', enabled ? 1 : 0, id);
    this.audit.record({
      actor,
      action: 'provider.enable',
      targetKind: 'provider',
      targetId: id,
      outcome: 'ok',
      detail: enabled ? 'Provider enabled' : 'Provider disabled',
    });
  }

  /**
   * Run a real capability check for a provider's execution path.
   * Status only becomes "verified" when this check passes — never before.
   */
  async check(id: string, actor: string): Promise<Provider | undefined> {
    const provider = this.get(id);
    if (!provider) return undefined;

    let status: ProviderStatus = 'unavailable';
    let notes = '';

    // Prefer the real execution adapter's own check when one exists.
    const adapter = this.adapters.get(provider.key);
    if (adapter) {
      const check = await adapter.check();
      status = check.status;
      notes = check.notes;
      const checkedAtAdapter = nowIso();
      this.db.run(
        'UPDATE providers SET status = ?, last_checked_at = ?, check_notes = ? WHERE id = ?',
        status, checkedAtAdapter, notes, id,
      );
      this.audit.record({
        actor, action: 'provider.check', targetKind: 'provider', targetId: id,
        outcome: status === 'verified' ? 'ok' : 'error', detail: notes, data: { status },
      });
      return this.get(id);
    }

    try {
      switch (provider.key) {
        case 'generic-cli': {
          const { stdout } = await execFileAsync('git', ['--version'], { timeout: 5_000 });
          status = 'verified';
          notes = `Verified: git available (${stdout.trim()}); safe command execution works.`;
          break;
        }
        case 'github-gh-cli': {
          try {
            await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 });
            status = 'verified';
            notes = 'Verified: gh CLI is authenticated and reachable.';
          } catch {
            status = 'unavailable';
            notes = 'gh CLI is not authenticated (or not installed). GitHub features will show as unavailable.';
          }
          break;
        }
        default: {
          status = 'unknown';
          notes = 'No automated check defined for this adapter; status remains explicitly unknown.';
        }
      }
    } catch (err) {
      status = 'unavailable';
      notes = `Check failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    const checkedAt = nowIso();
    this.db.run(
      'UPDATE providers SET status = ?, last_checked_at = ?, check_notes = ? WHERE id = ?',
      status, checkedAt, notes, id,
    );
    this.audit.record({
      actor,
      action: 'provider.check',
      targetKind: 'provider',
      targetId: id,
      outcome: status === 'verified' ? 'ok' : 'error',
      detail: notes,
      data: { status },
    });
    return this.get(id);
  }
}

export function toProvider(row: Record<string, unknown>): Provider {
  return {
    id: String(row.id),
    key: String(row.key),
    name: String(row.name),
    kind: row.kind as ProviderKind,
    executionMethod: row.execution_method as Provider['executionMethod'],
    authMethod: String(row.auth_method),
    status: row.status as ProviderStatus,
    capabilities: JSON.parse(String(row.capabilities)),
    models: JSON.parse(String(row.models)),
    prerequisites: JSON.parse(String(row.prerequisites)),
    limitations: JSON.parse(String(row.limitations)),
    lastCheckedAt: (row.last_checked_at as string) ?? null,
    checkNotes: (row.check_notes as string) ?? null,
    enabled: Number(row.enabled) === 1,
  };
}
