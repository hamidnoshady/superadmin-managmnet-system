import { DEFAULT_APPROVAL_POLICY, type ApprovalKind, type ApprovalPolicy } from '@dcc/core';
import { Database, nowIso } from '../db/database.js';
import { CONFIG } from '../config.js';
import type { AuditService } from './audit.js';

export interface AppSettings {
  scanRoots: string[];
  approvalPolicy: ApprovalPolicy;
  redactionEnabled: boolean;
  staleAfterMinutes: number;
  githubMode: 'gh_cli' | 'token_env' | 'unconfigured';
  /** Explicitly unverified items from the issue's open questions. */
  notes: {
    freebufIdentity: string;
    bizaMizApi: string;
    windowsTargets: string;
    existingAppInspection: string;
  };
}

export const DEFAULT_SETTINGS = (): AppSettings => ({
  scanRoots: CONFIG.defaultScanRoots,
  approvalPolicy: DEFAULT_APPROVAL_POLICY,
  redactionEnabled: true,
  staleAfterMinutes: CONFIG.staleAfterMinutes,
  githubMode: 'gh_cli',
  notes: {
    freebufIdentity:
      'UNRESOLVED: "Freebuf" identity not confirmed. No adapter is enabled until the owner confirms what it refers to.',
    bizaMizApi:
      'UNVERIFIED: no authenticated Biza Miz support/bug API or webhook is reachable from this environment. Manual intake only until verified.',
    windowsTargets:
      'UNDECIDED: minimum supported Windows version/arch not confirmed. Desktop packaging (Tauri) is planned but untested in this environment.',
    existingAppInspection:
      'UNAVAILABLE: existing app at D:\\Development\\arena development managment is on the owner\'s Windows machine and cannot be inspected from the build sandbox. Reuse decisions deferred.',
  },
});

/**
 * Settings are metadata only — secrets never live here. Secrets belong in the
 * OS-protected store (Windows Credential Manager / env of the user session).
 */
export class SettingsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  get(): AppSettings {
    const row = this.db.queryOne<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'app_settings');
    if (!row) {
      const defaults = DEFAULT_SETTINGS();
      this.save(defaults, 'system:init');
      return defaults;
    }
    const stored = JSON.parse(row.value) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS(), ...stored, notes: { ...DEFAULT_SETTINGS().notes, ...(stored.notes ?? {}) } };
  }

  save(settings: AppSettings, actor: string): AppSettings {
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      'app_settings',
      JSON.stringify(settings),
      nowIso(),
    );
    this.audit.record({
      actor,
      action: 'settings.update',
      targetKind: 'settings',
      targetId: 'app_settings',
      outcome: 'ok',
      detail: 'Settings updated (policy changes are consequential and audited)',
    });
    return settings;
  }

  setApprovalPolicy(policy: ApprovalPolicy, actor: string): AppSettings {
    const current = this.get();
    const next = { ...current, approvalPolicy: policy };
    this.audit.record({
      actor,
      action: 'settings.approval_policy_change',
      targetKind: 'settings',
      outcome: 'ok',
      detail: 'Approval policy changed',
      data: { required: policy.required },
    });
    return this.save(next, actor);
  }

  /**
   * Relaxing an approval gate is itself consequential: it requires an approved
   * `policy_change` request first unless it is being *tightened*.
   */
  canChangePolicy(current: ApprovalPolicy, next: ApprovalPolicy, approvedPolicyChange: boolean): { ok: boolean; reason?: string } {
    const removed = current.required.filter((k) => !(next.required as string[]).includes(k));
    if (removed.length > 0 && !approvedPolicyChange) {
      return {
        ok: false,
        reason: `Removing approval gates (${removed.join(', ')}) requires an approved policy_change request`,
      };
    }
    return { ok: true };
  }
}

export type { ApprovalKind };
