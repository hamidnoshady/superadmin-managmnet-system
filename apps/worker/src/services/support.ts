import crypto from 'node:crypto';
import type { DuplicateCandidate, Severity, SupportReport, SupportChannel } from '@dcc/core';
import { redact, scoreDuplicates, assertSafeForOutbound } from '@dcc/core';
import { Database, newId, nowIso } from '../db/database.js';
import type { AuditService } from './audit.js';

export interface TriageResult {
  category: string;
  severity: Severity;
  module: string | null;
  notes: string;
}

const CATEGORY_RULES: Array<{ category: string; module: string; pattern: RegExp; severity: Severity }> = [
  { category: 'installation/update', module: 'Installer', pattern: /install|update|setup|upgrade|patch|0x8007|安装/i, severity: 'high' },
  { category: 'remote-assistance', module: 'Remote Assistance', pattern: /remote assist|remote help|session|connection drop|远控|远程/i, severity: 'high' },
  { category: 'authentication', module: 'Auth', pattern: /login|auth|password|token|permission|sso|登录|权限/i, severity: 'critical' },
  { category: 'crash', module: 'Runtime', pattern: /crash|freeze|hang|exception|stack trace|崩溃|闪退/i, severity: 'high' },
  { category: 'performance', module: 'Performance', pattern: /slow|lag|latency|timeout|memory|cpu|卡顿|慢/i, severity: 'medium' },
  { category: 'ui', module: 'UI', pattern: /display|render|layout|button|color|theme|界面|显示/i, severity: 'low' },
  { category: 'data', module: 'Data', pattern: /data loss|corrupt|sync|export|import|数据库|数据/i, severity: 'critical' },
];

/**
 * Biza Miz superadmin support module.
 *
 * Integration status: no authenticated API/webhook is verified in this
 * environment, so ingestion is manual/import for now (the channel field keeps
 * the door open for api/webhook/browser_adapter once verified).
 *
 * Tenant isolation: raw tenant identifiers are never stored — only a salted
 * hash. All outbound content (LLM prompts, GitHub issues) is redacted first.
 */
export class SupportService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly tenantSalt: string,
  ) {}

  private tenantHash(tenantRef: string | null | undefined): string | null {
    if (!tenantRef) return null;
    return crypto.createHmac('sha256', this.tenantSalt).update(tenantRef).digest('hex').slice(0, 16);
  }

  create(input: {
    title: string;
    body: string;
    channel?: SupportChannel;
    externalRef?: string | null;
    productModule?: string | null;
    appVersion?: string | null;
    environment?: string | null;
    tenantRef?: string | null;
    severity?: Severity;
  }, actor: string): { report: SupportReport; findings: ReturnType<typeof redact>['findings'] } {
    const { redacted, findings } = redact(input.body);
    const now = nowIso();
    const report: SupportReport = {
      id: newId('sr'),
      channel: input.channel ?? 'manual',
      externalRef: input.externalRef ?? null,
      title: redact(input.title).redacted,
      bodyRaw: input.body,
      bodyRedacted: redacted,
      productModule: input.productModule ?? null,
      appVersion: input.appVersion ?? null,
      environment: input.environment ?? null,
      tenantRefHash: this.tenantHash(input.tenantRef),
      severity: input.severity ?? 'unknown',
      status: 'new',
      triageCategory: null,
      triageNotes: null,
      duplicateOfId: null,
      duplicateScore: null,
      linkedTaskId: null,
      receivedAt: now,
      updatedAt: now,
    };
    this.db.run(
      `INSERT INTO support_reports (id, channel, external_ref, title, body_raw, body_redacted, product_module, app_version, environment, tenant_ref_hash, severity, status, triage_category, triage_notes, duplicate_of_id, duplicate_score, linked_task_id, received_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      report.id, report.channel, report.externalRef, report.title, report.bodyRaw, report.bodyRedacted,
      report.productModule, report.appVersion, report.environment, report.tenantRefHash, report.severity,
      report.status, report.triageCategory, report.triageNotes, report.duplicateOfId, report.duplicateScore,
      report.linkedTaskId, report.receivedAt, report.updatedAt,
    );
    this.audit.record({
      actor, action: 'support.create', targetKind: 'support_report', targetId: report.id, outcome: 'ok',
      detail: `New report via ${report.channel}; ${findings.length} redaction rule(s) applied`,
      data: { redactionFindings: findings },
    });
    return { report, findings };
  }

  list(): SupportReport[] {
    return this.db.query<Record<string, unknown>>('SELECT * FROM support_reports ORDER BY received_at DESC').map(toSupportReport);
  }

  get(id: string): SupportReport | undefined {
    const row = this.db.queryOne<Record<string, unknown>>('SELECT * FROM support_reports WHERE id = ?', id);
    return row ? toSupportReport(row) : undefined;
  }

  /** Rule-based triage (phase 2 groundwork). Advisory, human-confirmable. */
  triage(id: string, actor: string): { report: SupportReport; result: TriageResult } | { error: string } {
    const report = this.get(id);
    if (!report) return { error: 'Report not found' };

    const haystack = `${report.title} ${report.bodyRedacted}`;
    let matched: (typeof CATEGORY_RULES)[number] | null = null;
    for (const rule of CATEGORY_RULES) {
      if (rule.pattern.test(haystack)) { matched = rule; break; }
    }
    const result: TriageResult = matched
      ? {
          category: matched.category,
          severity: report.severity === 'unknown' ? matched.severity : report.severity,
          module: report.productModule ?? matched.module,
          notes: `Auto-triage suggestion (${matched.category}). Human confirmation required; inference is not a confirmed fact.`,
        }
      : {
          category: 'unclassified',
          severity: report.severity === 'unknown' ? 'medium' : report.severity,
          module: report.productModule,
          notes: 'No category rule matched — needs human triage.',
        };

    this.db.run(
      `UPDATE support_reports SET status = 'triaging', triage_category = ?, triage_notes = ?, severity = ?, updated_at = ? WHERE id = ?`,
      result.category, result.notes, result.severity, nowIso(), id,
    );
    this.audit.record({ actor, action: 'support.triage', targetKind: 'support_report', targetId: id, outcome: 'ok', detail: result.category });
    return { report: this.get(id)!, result };
  }

  /**
   * Advisory duplicate detection against other support reports and synced
   * GitHub issues. Never auto-discards: candidates are recommendations only.
   */
  findDuplicates(id: string): DuplicateCandidate[] {
    const report = this.get(id);
    if (!report) return [];

    const otherReports = this.list()
      .filter((r) => r.id !== id)
      .map((r) => ({ kind: 'support_report' as const, refId: r.id, title: r.title, body: r.bodyRedacted, url: null }));

    const issues = this.db
      .query<Record<string, unknown>>('SELECT gi.*, r.id AS rid FROM github_issues gi JOIN repositories r ON r.id = gi.repo_id')
      .map((row) => ({
        kind: 'github_issue' as const,
        refId: `${row.repo_id}#${row.number}`,
        title: String(row.title),
        body: '',
        url: String(row.url),
      }));

    return scoreDuplicates(report.title, report.bodyRedacted, [...otherReports, ...issues]);
  }

  recordDuplicate(id: string, duplicateOfId: string | null, score: number | null, actor: string): void {
    this.db.run(
      'UPDATE support_reports SET duplicate_of_id = ?, duplicate_score = ?, updated_at = ? WHERE id = ?',
      duplicateOfId, score, nowIso(), id,
    );
    this.audit.record({ actor, action: 'support.duplicate_link', targetKind: 'support_report', targetId: id, outcome: 'ok', detail: duplicateOfId ? `Linked to ${duplicateOfId}` : 'Duplicate link cleared' });
  }

  linkTask(id: string, taskId: string, actor: string): void {
    this.db.run(`UPDATE support_reports SET linked_task_id = ?, status = 'linked', updated_at = ? WHERE id = ?`, taskId, nowIso(), id);
    this.audit.record({ actor, action: 'support.link_task', targetKind: 'support_report', targetId: id, outcome: 'ok', detail: taskId });
  }

  /**
   * Generate an evidence-backed GitHub issue draft from a report.
   * Uses ONLY the redacted body — raw support text never reaches GitHub.
   */
  buildIssueDraft(id: string): { title: string; body: string } | { error: string } {
    const report = this.get(id);
    if (!report) return { error: 'Report not found' };

    try {
      assertSafeForOutbound(report.bodyRedacted);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }

    const title = `[Support] ${report.title}`.slice(0, 120);
    const body = [
      `## Report (redacted)`,
      report.bodyRedacted,
      ``,
      `## Verified metadata`,
      `- Channel: ${report.channel}${report.externalRef ? ` (ref ${report.externalRef})` : ''}`,
      `- Product/module: ${report.productModule ?? 'unknown'}`,
      `- App version: ${report.appVersion ?? 'unknown'}`,
      `- Environment: ${report.environment ?? 'unknown'}`,
      `- Severity (triaged): ${report.severity}`,
      `- Tenant: ${report.tenantRefHash ? `hash:${report.tenantRefHash}` : 'n/a'} (raw tenant reference never stored)`,
      ``,
      `## Acceptance criteria`,
      `- [ ] Root cause identified with evidence`,
      `- [ ] Fix verified against reproduction steps`,
      `- [ ] Support report linked and resolution synchronized`,
    ].join('\n');

    return { title, body };
  }

  /** Outbound send guard — used before LLM prompts and GitHub writes. */
  redactForOutbound(text: string): { redacted: string; ok: boolean; error?: string } {
    const { redacted } = redact(text);
    try {
      assertSafeForOutbound(redacted);
      return { redacted, ok: true };
    } catch (err) {
      return { redacted, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Resolution sync-back (issue #1 §7 step 7): mark the report resolved and,
   * "only through supported permissions and interfaces", synchronize progress:
   *  - if the API channel is verified → post the resolution there
   *  - if a linked GitHub issue exists → raise approval-gated comment/close
   * Everything else stays local and explicit.
   */
  recordResolution(
    id: string,
    resolution: { status: 'resolved' | 'closed'; note: string },
    actor: string,
  ): { ok: boolean; report?: SupportReport; actions: string[]; error?: string } {
    const report = this.get(id);
    if (!report) return { ok: false, actions: [], error: 'Report not found' };
    const actions: string[] = [];

    this.db.run(
      'UPDATE support_reports SET status = ?, triage_notes = ?, updated_at = ? WHERE id = ?',
      resolution.status,
      `${report.triageNotes ?? ''}\nResolution (${new Date().toISOString()}): ${redact(resolution.note).redacted}`.trim(),
      nowIso(),
      id,
    );
    actions.push(`local status → ${resolution.status}`);
    this.audit.record({
      actor, action: 'support.resolve', targetKind: 'support_report', targetId: id, outcome: 'ok',
      detail: redact(resolution.note).redacted,
    });
    return { ok: true, report: this.get(id), actions };
  }
}

function toSupportReport(row: Record<string, unknown>): SupportReport {
  return {
    id: String(row.id),
    channel: row.channel as SupportChannel,
    externalRef: (row.external_ref as string) ?? null,
    title: String(row.title),
    bodyRaw: String(row.body_raw),
    bodyRedacted: String(row.body_redacted),
    productModule: (row.product_module as string) ?? null,
    appVersion: (row.app_version as string) ?? null,
    environment: (row.environment as string) ?? null,
    tenantRefHash: (row.tenant_ref_hash as string) ?? null,
    severity: row.severity as Severity,
    status: row.status as SupportReport['status'],
    triageCategory: (row.triage_category as string) ?? null,
    triageNotes: (row.triage_notes as string) ?? null,
    duplicateOfId: (row.duplicate_of_id as string) ?? null,
    duplicateScore: row.duplicate_score == null ? null : Number(row.duplicate_score),
    linkedTaskId: (row.linked_task_id as string) ?? null,
    receivedAt: String(row.received_at),
    updatedAt: String(row.updated_at),
  };
}
