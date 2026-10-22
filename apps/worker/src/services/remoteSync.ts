import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import type { SecretStore } from './secrets.js';
import type { AuditService } from './audit.js';
import type { BackupService } from './backup.js';

export interface RemoteSyncConfig {
  /** Base URL of the optional sync service (empty = disabled). */
  endpoint: string;
  /** Env/secret name holding the bearer token. */
  tokenEnv: string;
}

export const DEFAULT_REMOTE_SYNC: RemoteSyncConfig = { endpoint: '', tokenEnv: 'DCC_SYNC_TOKEN' };

/**
 * Optional multi-device sync (issue #1: "Optional remote service later, only
 * if multi-device/team synchronization ... requires it").
 *
 * Implemented as explicit, owner-triggered bundle push/pull against a
 * configured endpoint — no background service, no implicit cloud. Pulls land
 * in the backups directory and must pass validation before any restore.
 */
export class RemoteSyncService {
  constructor(
    private readonly secrets: SecretStore,
    private readonly audit: AuditService,
    private readonly backup: BackupService,
  ) {}

  getConfig(): RemoteSyncConfig {
    return { ...DEFAULT_REMOTE_SYNC, endpoint: process.env.DCC_SYNC_ENDPOINT ?? '', tokenEnv: process.env.DCC_SYNC_TOKEN_ENV ?? 'DCC_SYNC_TOKEN' };
  }

  async checkConnection(): Promise<{ status: 'disabled' | 'verified' | 'unavailable'; notes: string }> {
    const config = this.getConfig();
    if (!config.endpoint) return { status: 'disabled', notes: 'Remote sync is optional and not configured. Workspace bundles can still be exported/imported manually.' };
    try {
      const res = await fetch(`${config.endpoint.replace(/\/$/, '')}/health`, { headers: await this.headers(), signal: AbortSignal.timeout(5_000) });
      if (res.ok) return { status: 'verified', notes: 'Sync endpoint reachable.' };
      return { status: 'unavailable', notes: `Sync endpoint returned HTTP ${res.status}.` };
    } catch (err) {
      return { status: 'unavailable', notes: `Sync endpoint unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async push(actor: string): Promise<{ ok: boolean; note: string; bytes?: number }> {
    const config = this.getConfig();
    if (!config.endpoint) return { ok: false, note: 'Remote sync not configured — nothing was sent.' };
    const bundle = await this.backup.exportBundle(actor);
    const body = fs.readFileSync(bundle.file);
    try {
      const res = await fetch(`${config.endpoint.replace(/\/$/, '')}/bundles`, {
        method: 'POST',
        headers: { ...(await this.headers()), 'Content-Type': 'application/octet-stream', 'X-Dcc-Bundle-Name': path.basename(bundle.file) },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const note = `Push failed: HTTP ${res.status}`;
        this.audit.record({ actor, action: 'sync.push', targetKind: 'system', outcome: 'error', detail: note });
        return { ok: false, note };
      }
      this.audit.record({ actor, action: 'sync.push', targetKind: 'system', outcome: 'ok', detail: `Pushed ${body.length} bytes` });
      return { ok: true, note: `Pushed ${path.basename(bundle.file)} (${Math.round(body.length / 1024)} KB).`, bytes: body.length };
    } catch (err) {
      const note = `Push failed: ${err instanceof Error ? err.message : String(err)}`;
      this.audit.record({ actor, action: 'sync.push', targetKind: 'system', outcome: 'error', detail: note });
      return { ok: false, note };
    }
  }

  async pull(actor: string): Promise<{ ok: boolean; note: string; file?: string }> {
    const config = this.getConfig();
    if (!config.endpoint) return { ok: false, note: 'Remote sync not configured — nothing was fetched.' };
    try {
      const res = await fetch(`${config.endpoint.replace(/\/$/, '')}/bundles/latest`, { headers: await this.headers(), signal: AbortSignal.timeout(60_000) });
      if (!res.ok) {
        const note = `Pull failed: HTTP ${res.status}`;
        this.audit.record({ actor, action: 'sync.pull', targetKind: 'system', outcome: 'error', detail: note });
        return { ok: false, note };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const file = path.join(CONFIG.dataDir, 'backups', `remote-${Date.now()}.sqlite`);
      fs.writeFileSync(file, buf);
      const validation = this.backup.validate(file);
      if (!validation.ok) {
        // Never install a bundle that does not validate.
        fs.rmSync(file, { force: true });
        const note = `Pulled bundle failed validation (${validation.error ?? 'unknown'}) — it was discarded, not installed.`;
        this.audit.record({ actor, action: 'sync.pull', targetKind: 'system', outcome: 'error', detail: note });
        return { ok: false, note };
      }
      this.audit.record({ actor, action: 'sync.pull', targetKind: 'system', outcome: 'ok', detail: `Pulled and validated bundle (${JSON.stringify(validation.counts)})` });
      return { ok: true, note: `Bundle pulled and validated (${JSON.stringify(validation.counts)}). Use Restore in Settings to install it.`, file };
    } catch (err) {
      const note = `Pull failed: ${err instanceof Error ? err.message : String(err)}`;
      this.audit.record({ actor, action: 'sync.pull', targetKind: 'system', outcome: 'error', detail: note });
      return { ok: false, note };
    }
  }

  private async headers(): Promise<Record<string, string>> {
    const config = this.getConfig();
    const token = await this.secrets.resolveEnvRef(config.tokenEnv);
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
}
