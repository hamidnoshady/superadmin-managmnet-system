import type { SupportChannel, Severity } from '@dcc/core';
import { Database, newId, nowIso } from '../db/database.js';
import type { AuditService } from './audit.js';
import type { SupportService } from './support.js';

export interface BizaMizConfig {
  /** Base URL of the authenticated support/bug API — empty = unconfigured. */
  apiUrl: string;
  /** Name of the environment variable that holds the bearer token (never the token itself). */
  authEnv: string;
  /** Name of the environment variable holding the inbound webhook shared secret. */
  webhookSecretEnv: string;
}

export const DEFAULT_BIZA_MIZ: BizaMizConfig = {
  apiUrl: '',
  authEnv: 'BIZA_MIZ_TOKEN',
  webhookSecretEnv: 'DCC_WEBHOOK_SECRET',
};

export interface IngestResult {
  channel: SupportChannel;
  ok: boolean;
  imported: number;
  skipped: number;
  errors: string[];
  note: string;
}

export interface RawReport {
  title: string;
  body: string;
  externalRef?: string | null;
  productModule?: string | null;
  appVersion?: string | null;
  environment?: string | null;
  tenantRef?: string | null;
  severity?: Severity;
}

/**
 * Biza Miz ingestion channels.
 *
 * Preferred: authenticated API or webhook. Until one is configured and
 * verified, only manual/import intake works — and every other channel reports
 * itself `unavailable` instead of failing silently.
 */
export class IngestService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly support: SupportService,
  ) {}

  getConfig(): BizaMizConfig {
    const row = this.db.queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'biza_miz');
    if (!row) return DEFAULT_BIZA_MIZ;
    try {
      return { ...DEFAULT_BIZA_MIZ, ...JSON.parse(row.value) };
    } catch {
      return DEFAULT_BIZA_MIZ;
    }
  }

  saveConfig(config: Partial<BizaMizConfig>, actor: string): BizaMizConfig {
    const next = { ...this.getConfig(), ...config };
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES ('biza_miz', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      JSON.stringify(next), nowIso(),
    );
    this.audit.record({ actor, action: 'ingest.config', targetKind: 'settings', targetId: 'biza_miz', outcome: 'ok', detail: 'Biza Miz ingestion config updated (no secrets stored — env var names only)' });
    return next;
  }

  /** Capability check: is an authenticated API actually configured and reachable? */
  async checkConnection(): Promise<{ status: 'verified' | 'unconfigured' | 'unavailable'; notes: string; checkedAt: string }> {
    const config = this.getConfig();
    const checkedAt = nowIso();
    if (!config.apiUrl) {
      return {
        status: 'unconfigured',
        notes: 'No Biza Miz API URL configured. Manual/import intake only. Set the API URL and token env var name in Settings once the interface is confirmed.',
        checkedAt,
      };
    }
    const token = process.env[config.authEnv];
    if (!token) {
      return {
        status: 'unavailable',
        notes: `API URL configured but the token env var ${config.authEnv} is empty. Never store tokens in the database.`,
        checkedAt,
      };
    }
    try {
      const res = await fetch(`${config.apiUrl.replace(/\/$/, '')}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return { status: 'verified', notes: 'Authenticated API reachable.', checkedAt };
      return { status: 'unavailable', notes: `API responded with HTTP ${res.status}.`, checkedAt };
    } catch (err) {
      return { status: 'unavailable', notes: `API unreachable: ${err instanceof Error ? err.message : String(err)}`, checkedAt };
    }
  }

  /**
   * Pull new bug reports/tickets from the configured API.
   * Honest failure: unconfigured/unavailable never imports fake data.
   */
  async ingestFromApi(actor: string): Promise<IngestResult> {
    const connection = await this.checkConnection();
    const base: IngestResult = { channel: 'api', ok: false, imported: 0, skipped: 0, errors: [], note: connection.notes };
    if (connection.status !== 'verified') {
      this.recordBatch('api', this.getConfig().apiUrl || '(unconfigured)', base);
      this.audit.record({ actor, action: 'ingest.api', targetKind: 'support', outcome: 'error', detail: connection.notes });
      return base;
    }

    const config = this.getConfig();
    const token = process.env[config.authEnv]!;
    try {
      const res = await fetch(`${config.apiUrl.replace(/\/$/, '')}/bug-reports?since=2020-01-01`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json()) as { items?: RawReport[] };
      const result = this.importBatch(data.items ?? [], 'api', config.apiUrl, actor);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      base.errors.push(message);
      base.note = `API ingestion failed: ${message}`;
      this.recordBatch('api', config.apiUrl, base);
      this.audit.record({ actor, action: 'ingest.api', targetKind: 'support', outcome: 'error', detail: message });
      return base;
    }
  }

  /**
   * Inbound webhook receiver. Authenticates via shared secret header
   * (`x-dcc-webhook-secret`), then ingests reports through the same redaction
   * pipeline as every other channel.
   */
  ingestFromWebhook(headers: Record<string, string | undefined>, body: { items?: RawReport[] } | RawReport, actor: string): IngestResult {
    const config = this.getConfig();
    const expected = process.env[config.webhookSecretEnv];
    const provided = headers['x-dcc-webhook-secret'];
    if (!expected || expected.length < 8) {
      const result: IngestResult = {
        channel: 'webhook', ok: false, imported: 0, skipped: 0, errors: [],
        note: `Webhook secret not configured (set ${config.webhookSecretEnv}). Rejecting input — no unauthenticated ingestion.`,
      };
      this.audit.record({ actor, action: 'ingest.webhook', targetKind: 'support', outcome: 'denied', detail: result.note });
      return result;
    }
    if (!provided || provided !== expected) {
      const result: IngestResult = {
        channel: 'webhook', ok: false, imported: 0, skipped: 0, errors: ['invalid webhook secret'],
        note: 'Rejected: invalid or missing webhook secret.',
      };
      this.audit.record({ actor, action: 'ingest.webhook', targetKind: 'support', outcome: 'denied', detail: result.note });
      return result;
    }

    const items = 'items' in body && Array.isArray(body.items) ? body.items : [body as RawReport];
    return this.importBatch(items, 'webhook', 'inbound-webhook', actor);
  }

  /** Bulk import (manual/admin channel) — same redaction pipeline. */
  importBatch(items: RawReport[], channel: SupportChannel, source: string, actor: string): IngestResult {
    const result: IngestResult = { channel, ok: true, imported: 0, skipped: 0, errors: [], note: '' };
    for (const item of items) {
      if (!item?.title || !item?.body) {
        result.skipped += 1;
        result.errors.push(`Skipped item without title/body: ${JSON.stringify(item?.title ?? item?.externalRef ?? '?').slice(0, 60)}`);
        continue;
      }
      try {
        this.support.create({
          title: item.title,
          body: item.body,
          channel,
          externalRef: item.externalRef ?? null,
          productModule: item.productModule ?? null,
          appVersion: item.appVersion ?? null,
          environment: item.environment ?? null,
          tenantRef: item.tenantRef ?? null,
          severity: item.severity,
        }, actor);
        result.imported += 1;
      } catch (err) {
        result.skipped += 1;
        result.errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    result.note = `Imported ${result.imported}, skipped ${result.skipped} via ${channel}.`;
    this.recordBatch(channel, source, result);
    this.audit.record({
      actor, action: `ingest.${channel}`, targetKind: 'support', outcome: result.errors.length > 0 ? 'error' : 'ok',
      detail: result.note, data: { errors: result.errors.slice(0, 5) },
    });
    return result;
  }

  private recordBatch(channel: string, source: string, result: IngestResult): void {
    this.db.run(
      `INSERT INTO ingest_batches (id, channel, source, imported, skipped, errors, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId('ing'), channel, source, result.imported, result.skipped, JSON.stringify(result.errors), nowIso(),
    );
  }

  listBatches(): Array<Record<string, unknown>> {
    return this.db.query('SELECT * FROM ingest_batches ORDER BY created_at DESC LIMIT 50');
  }

  /**
   * Resolution sync-back to Biza Miz over the supported API interface.
   * If the channel is not verified, the sync is reported as unavailable and
   * nothing is faked.
   */
  async postResolution(
    externalRef: string,
    resolution: { status: string; note: string },
    actor: string,
  ): Promise<{ ok: boolean; note: string }> {
    const connection = await this.checkConnection();
    if (connection.status !== 'verified') {
      const note = `Resolution sync-back unavailable (${connection.status}) — resolution recorded locally only. ${connection.notes}`;
      this.audit.record({ actor, action: 'ingest.resolve_sync', targetKind: 'support', outcome: 'error', detail: note });
      return { ok: false, note };
    }
    const config = this.getConfig();
    const token = process.env[config.authEnv]!;
    try {
      const res = await fetch(`${config.apiUrl.replace(/\/$/, '')}/bug-reports/${encodeURIComponent(externalRef)}/resolution`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: resolution.status, note: resolution.note }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const note = `Resolution sync-back failed: HTTP ${res.status}`;
        this.audit.record({ actor, action: 'ingest.resolve_sync', targetKind: 'support', outcome: 'error', detail: note });
        return { ok: false, note };
      }
      this.audit.record({ actor, action: 'ingest.resolve_sync', targetKind: 'support', outcome: 'ok', detail: `Synced resolution for ${externalRef}` });
      return { ok: true, note: 'Resolution synchronized to Biza Miz.' };
    } catch (err) {
      const note = `Resolution sync-back failed: ${err instanceof Error ? err.message : String(err)}`;
      this.audit.record({ actor, action: 'ingest.resolve_sync', targetKind: 'support', outcome: 'error', detail: note });
      return { ok: false, note };
    }
  }
}
