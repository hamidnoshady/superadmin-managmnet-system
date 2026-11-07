import type { AuditEntry } from '@dcc/core';
import { Database, newId, nowIso } from '../db/database.js';

export type AuditOutcome = 'ok' | 'denied' | 'error';

export interface AuditInput {
  actor: string;
  action: string;
  targetKind: string;
  targetId?: string | null;
  outcome: AuditOutcome;
  detail?: string | null;
  data?: Record<string, unknown> | null;
}

/**
 * Append-only audit trail.
 * "Audit records for user decisions, agent actions, provider, task, changed
 * files, commands, outcomes, and timestamps." Never updated, never deleted.
 */
export class AuditService {
  constructor(private readonly db: Database) {}

  record(input: AuditInput): AuditEntry {
    const entry: AuditEntry = {
      id: newId('aud'),
      at: nowIso(),
      actor: input.actor,
      action: input.action,
      targetKind: input.targetKind,
      targetId: input.targetId ?? null,
      outcome: input.outcome,
      detail: input.detail ?? null,
      data: input.data ?? null,
    };
    this.db.run(
      `INSERT INTO audit_log (id, at, actor, action, target_kind, target_id, outcome, detail, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.id,
      entry.at,
      entry.actor,
      entry.action,
      entry.targetKind,
      entry.targetId,
      entry.outcome,
      entry.detail,
      entry.data ? JSON.stringify(entry.data) : null,
    );
    return entry;
  }

  list(limit = 200): AuditEntry[] {
    const rows = this.db.query<Record<string, unknown>>('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?', limit);
    return rows.map(toAuditEntry);
  }
}

export function toAuditEntry(row: Record<string, unknown>): AuditEntry {
  return {
    id: String(row.id),
    at: String(row.at),
    actor: String(row.actor),
    action: String(row.action),
    targetKind: String(row.target_kind),
    targetId: (row.target_id as string) ?? null,
    outcome: row.outcome as AuditEntry['outcome'],
    detail: (row.detail as string) ?? null,
    data: row.data ? JSON.parse(String(row.data)) : null,
  };
}
