import type { ApprovalRequest, ApprovalKind } from '@dcc/core';
import { checkApproval, DEFAULT_APPROVAL_POLICY, type ApprovalPolicy } from '@dcc/core';
import { Database, newId, nowIso } from '../db/database.js';
import type { AuditService } from './audit.js';

/**
 * Approval queue.
 *
 * Every consequential external write (GitHub, deploy, destructive git, LLM
 * sends) needs an approved request before execution. Decisions are audited.
 */
export class ApprovalService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY,
  ) {}

  setPolicy(policy: ApprovalPolicy): void {
    this.policy = policy;
  }

  request(input: {
    kind: ApprovalKind;
    title: string;
    payload: Record<string, unknown>;
    requestedBy: string;
  }): ApprovalRequest {
    const req: ApprovalRequest = {
      id: newId('apr'),
      kind: input.kind,
      title: input.title,
      payload: input.payload,
      status: 'pending',
      requestedBy: input.requestedBy,
      decidedBy: null,
      decidedAt: null,
      reason: null,
      createdAt: nowIso(),
    };
    this.db.run(
      `INSERT INTO approvals (id, kind, title, payload, status, requested_by, decided_by, decided_at, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      req.id, req.kind, req.title, JSON.stringify(req.payload), req.status,
      req.requestedBy, req.decidedBy, req.decidedAt, req.reason, req.createdAt,
    );
    this.audit.record({
      actor: input.requestedBy,
      action: 'approval.request',
      targetKind: 'approval',
      targetId: req.id,
      outcome: 'ok',
      detail: `${req.kind}: ${req.title}`,
    });
    return req;
  }

  decide(id: string, decision: 'approved' | 'rejected', decidedBy: string, reason?: string): { ok: boolean; request?: ApprovalRequest; error?: string } {
    const row = this.db.queryOne<Record<string, unknown>>('SELECT * FROM approvals WHERE id = ?', id);
    if (!row) return { ok: false, error: 'Approval request not found' };
    if (row.status !== 'pending') return { ok: false, error: `Request already ${row.status}` };

    const decidedAt = nowIso();
    this.db.run(
      'UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, reason = ? WHERE id = ?',
      decision, decidedBy, decidedAt, reason ?? null, id,
    );
    this.audit.record({
      actor: decidedBy,
      action: `approval.${decision}`,
      targetKind: 'approval',
      targetId: id,
      outcome: 'ok',
      detail: `${String(row.kind)} "${String(row.title)}" ${decision}${reason ? `: ${reason}` : ''}`,
      data: row.payload ? JSON.parse(String(row.payload)) : null,
    });
    return { ok: true, request: this.get(id) };
  }

  get(id: string): ApprovalRequest | undefined {
    const row = this.db.queryOne<Record<string, unknown>>('SELECT * FROM approvals WHERE id = ?', id);
    return row ? toApproval(row) : undefined;
  }

  list(status?: ApprovalRequest['status']): ApprovalRequest[] {
    const rows = status
      ? this.db.query<Record<string, unknown>>('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC', status)
      : this.db.query<Record<string, unknown>>('SELECT * FROM approvals ORDER BY created_at DESC');
    return rows.map(toApproval);
  }

  /** Gate check used immediately before executing a consequential action. */
  checkGate(kind: ApprovalKind, approvalId?: string | null): ReturnType<typeof checkApproval> {
    let approved = false;
    let requestedAt: string | null = null;
    if (approvalId) {
      const req = this.get(approvalId);
      approved = req?.status === 'approved';
      requestedAt = req?.createdAt ?? null;
      if (req && req.status === 'pending') {
        return { ok: false, requiresApproval: true, reason: `Approval request ${approvalId} is still pending` };
      }
      if (req && req.status === 'rejected') {
        return { ok: false, requiresApproval: true, reason: `Approval request ${approvalId} was rejected` };
      }
    }
    return checkApproval(this.policy, kind, { approved, requestedAt });
  }
}

function toApproval(row: Record<string, unknown>): ApprovalRequest {
  return {
    id: String(row.id),
    kind: row.kind as ApprovalKind,
    title: String(row.title),
    payload: JSON.parse(String(row.payload ?? '{}')),
    status: row.status as ApprovalRequest['status'],
    requestedBy: String(row.requested_by),
    decidedBy: (row.decided_by as string) ?? null,
    decidedAt: (row.decided_at as string) ?? null,
    reason: (row.reason as string) ?? null,
    createdAt: String(row.created_at),
  };
}
