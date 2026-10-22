import { useEffect, useState } from 'react';
import type { DuplicateCandidate, SupportReport } from '@dcc/core';
import { api } from '../api';
import { Badge, Card, EmptyState, SectionTitle, SeverityBadge, timeAgo } from '../components';

export default function Support(): JSX.Element {
  const [reports, setReports] = useState<SupportReport[]>([]);
  const [selected, setSelected] = useState<SupportReport | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [redaction, setRedaction] = useState<Array<{ kind: string; count: number }> | null>(null);
  const [form, setForm] = useState({ title: '', body: '', productModule: '', appVersion: '', environment: 'production', tenantRef: '' });
  const [ingestStatus, setIngestStatus] = useState<{ status: string; notes: string; checkedAt: string } | null>(null);
  const [ingestCfg, setIngestCfg] = useState<{ apiUrl: string; authEnv: string; webhookSecretEnv: string } | null>(null);
  const [batches, setBatches] = useState<Array<{ id: string; channel: string; source: string | null; imported: number; skipped: number; errors: string; created_at: string }>>([]);
  const [importText, setImportText] = useState('');

  const load = () => {
    api.supportReports().then(setReports);
    api.ingestCheck().then(setIngestStatus).catch(() => setIngestStatus(null));
    api.ingestConfig().then(setIngestCfg).catch(() => setIngestCfg(null));
    api.ingestBatches().then(setBatches).catch(() => setBatches([]));
  };
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (!selected) { setDuplicates([]); return; }
    api.reportDuplicates(selected.id).then(setDuplicates);
  }, [selected]);

  const submit = async () => {
    const result = await api.createSupportReport({
      title: form.title,
      body: form.body,
      productModule: form.productModule || null,
      appVersion: form.appVersion || null,
      environment: form.environment || null,
      tenantRef: form.tenantRef || null,
    });
    setRedaction(result.redactionFindings);
    setMessage(`Report saved. ${result.redactionFindings.length} redaction rule(s) applied — raw tenant refs are hashed, secrets are stripped before anything leaves this machine.`);
    setForm({ title: '', body: '', productModule: '', appVersion: '', environment: 'production', tenantRef: '' });
    load();
  };

  const triage = async (id: string) => {
    const result = await api.triageReport(id);
    setMessage(`Triage suggestion: ${result.result.category} (${result.report.severity}). Inference only — human confirmation required.`);
    load();
    if (selected?.id === id) setSelected(result.report);
  };

  const issueDraft = async (id: string) => {
    const result = await api.reportIssueDraft(id);
    setMessage(`Issue draft prepared (approval request ${result.approval.id} pending). Only the redacted body will be sent to GitHub after approval.`);
    load();
  };

  const resolve = async (id: string) => {
    const note = window.prompt('Resolution note (recorded as evidence, redacted before any outbound sync):') ?? '';
    if (!note.trim()) return;
    const result = await api.resolveReport(id, { status: 'resolved', note });
    const extras = result.actions?.length ? ` Sync: ${result.actions.join('; ')}` : '';
    setMessage(result.ok ? `Report marked resolved locally.${extras}` : `Failed: ${result.error}`);
    load();
  };

  return (
    <div>
      <SectionTitle
        title="Biza Miz Support & Bug Reports"
        hint="API/webhook access is unverified — manual intake; tenant isolation and redaction are mandatory"
      />

      <div className="notice warn" style={{ marginBottom: 14 }}>
        Integration status: <strong>authenticated Biza Miz API not connected</strong> (unavailable — never shown as healthy).
        Reports below are ingested manually. Tenant references are stored only as salted hashes; secrets and personal data are redacted on intake.
      </div>

      {message && <div className="notice ok" style={{ marginBottom: 14 }}>{message}</div>}
      {redaction && redaction.length > 0 && (
        <div className="notice" style={{ marginBottom: 14 }}>
          Redaction findings on last intake: {redaction.map((f) => `${f.kind}×${f.count}`).join(', ')}
        </div>
      )}

      <Card title="Ingestion channels">
        <div className="grid cols-3">
          <div>
            <div className="row">
              <Badge color={ingestStatus?.status === 'verified' ? 'green' : ingestStatus?.status === 'unconfigured' ? 'amber' : 'red'} dot>
                API: {ingestStatus?.status ?? 'checking'}
              </Badge>
              <button className="btn small" onClick={async () => { const r = await api.ingestApi(); setMessage(r.note); load(); }}>Pull from API</button>
            </div>
            <div className="faint" style={{ marginTop: 8 }}>{ingestStatus?.notes}</div>
            {ingestCfg && (
              <div className="faint mono" style={{ marginTop: 6 }}>
                url: {ingestCfg.apiUrl || '(unset)'}<br />
                token env: {ingestCfg.authEnv} · webhook secret env: {ingestCfg.webhookSecretEnv}
              </div>
            )}
          </div>
          <div>
            <Badge color="blue" dot>Webhook receiver</Badge>
            <div className="faint" style={{ marginTop: 8 }}>
              POST <span className="mono">/api/ingest/webhook</span> with header <span className="mono">x-dcc-webhook-secret</span>.
              Unauthenticated payloads are rejected — configure the secret env var on the worker first.
            </div>
          </div>
          <div>
            <Badge color="purple" dot>Manual / import</Badge>
            <div className="field" style={{ marginTop: 8 }}>
              <textarea
                style={{ minHeight: 64 }}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder='[{"title":"…","body":"…","tenantRef":"TEN-1"}]'
              />
            </div>
            <button
              className="btn small"
              disabled={!importText.trim()}
              onClick={async () => {
                try {
                  const items = JSON.parse(importText);
                  const r = await api.ingestImport(Array.isArray(items) ? items : [items], 'ui-import');
                  setMessage(r.note);
                  setImportText('');
                  load();
                } catch {
                  setMessage('Import failed: invalid JSON');
                }
              }}
            >
              Import JSON (redacted)
            </button>
          </div>
        </div>
        {batches.length > 0 && (
          <>
            <div className="divider" />
            <div className="faint">Recent ingestion batches:</div>
            {batches.slice(0, 4).map((b) => (
              <div key={b.id} className="faint" style={{ marginTop: 4 }}>
                <span className="mono">{b.channel}</span> from {b.source ?? '—'} · imported {b.imported} · skipped {b.skipped} · {timeAgo(b.created_at)}
              </div>
            ))}
          </>
        )}
      </Card>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <Card title="New report intake">
          <div className="field">
            <label>Title</label>
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Installation fails during update on Windows 11" />
          </div>
          <div className="field">
            <label>Report body (as received — will be stored raw + redacted)</label>
            <textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Paste the customer report, including any error codes and logs…" />
          </div>
          <div className="form-row">
            <div className="field">
              <label>Product / module</label>
              <input value={form.productModule} onChange={(e) => setForm({ ...form, productModule: e.target.value })} placeholder="Installer" />
            </div>
            <div className="field">
              <label>App version</label>
              <input value={form.appVersion} onChange={(e) => setForm({ ...form, appVersion: e.target.value })} placeholder="2.3.1" />
            </div>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Environment</label>
              <input value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })} />
            </div>
            <div className="field">
              <label>Tenant reference (hashed on save)</label>
              <input value={form.tenantRef} onChange={(e) => setForm({ ...form, tenantRef: e.target.value })} placeholder="TEN-4471" />
            </div>
          </div>
          <button className="btn primary" disabled={!form.title || !form.body} onClick={submit}>Ingest report (redacted)</button>
        </Card>

        <Card title="Report detail">
          {!selected ? (
            <EmptyState>Select a report to inspect, triage, and prepare an issue draft.</EmptyState>
          ) : (
            <>
              <div className="row wrap">
                <Badge color="blue">{selected.status}</Badge>
                <SeverityBadge severity={selected.severity} />
                <Badge color="gray">channel: {selected.channel}</Badge>
                {selected.tenantRefHash && <Badge color="purple">tenant hash {selected.tenantRefHash}</Badge>}
              </div>
              <h3 style={{ margin: '12px 0 6px', fontSize: 15, textTransform: 'none', color: 'var(--text)' }}>{selected.title}</h3>
              <div className="faint">received {timeAgo(selected.receivedAt)} · module {selected.productModule ?? '—'} · v{selected.appVersion ?? '—'} · {selected.environment ?? '—'}</div>

              <div className="divider" />
              <div className="faint">Redacted body (safe for LLMs and GitHub):</div>
              <div className="log" style={{ marginTop: 6 }}>{selected.bodyRedacted}</div>
              <details className="raw">
                <summary>Original body (never sent to LLMs/GitHub)</summary>
                <pre>{selected.bodyRaw}</pre>
              </details>

              {selected.triageNotes && (
                <div className="notice" style={{ marginTop: 8 }}>
                  <Badge color="purple">inferred</Badge> {selected.triageNotes}
                  {selected.triageCategory && <> · category: <strong>{selected.triageCategory}</strong></>}
                </div>
              )}

              <div className="divider" />
              <div className="faint">Advisory duplicate detection (recommendations only — nothing is auto-discarded):</div>
              {duplicates.length === 0 ? (
                <div className="faint" style={{ margin: '6px 0' }}>No similar reports/issues above threshold.</div>
              ) : (
                <div className="link-list" style={{ margin: '6px 0' }}>
                  {duplicates.map((d) => (
                    <div key={`${d.kind}-${d.refId}`} className="notice">
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <strong>{d.title}</strong>
                        <Badge color={d.score >= 0.72 ? 'amber' : 'gray'}>score {d.score}</Badge>
                      </div>
                      <div className="faint">{d.kind} · {d.rationale}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className="row wrap" style={{ marginTop: 12 }}>
                <button className="btn small" onClick={() => triage(selected.id)}>Run triage</button>
                <button className="btn small primary" onClick={() => issueDraft(selected.id)}>Prepare issue draft (needs approval)</button>
                {selected.status !== 'resolved' && selected.status !== 'closed' && (
                  <button className="btn small success" onClick={() => resolve(selected.id)}>Mark resolved</button>
                )}
                <button className="btn small" onClick={() => setSelected(null)}>Close</button>
              </div>
            </>
          )}
        </Card>
      </div>

      <SectionTitle title={`All reports (${reports.length})`} />
      {reports.length === 0 ? (
        <EmptyState>No support reports yet. Ingest one above.</EmptyState>
      ) : (
        <Card>
          <table className="data">
            <thead><tr><th>Title</th><th>Status</th><th>Severity</th><th>Module</th><th>Redacted</th><th>Received</th></tr></thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id} onClick={() => setSelected(r)} style={{ cursor: 'pointer' }}>
                  <td>{r.title}</td>
                  <td><Badge color={r.status === 'linked' ? 'green' : r.status === 'triaging' ? 'blue' : 'gray'}>{r.status}</Badge></td>
                  <td><SeverityBadge severity={r.severity} /></td>
                  <td className="faint">{r.productModule ?? '—'}</td>
                  <td className="faint">yes · {r.tenantRefHash ? `hash ${r.tenantRefHash}` : 'no tenant ref'}</td>
                  <td className="faint">{timeAgo(r.receivedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
