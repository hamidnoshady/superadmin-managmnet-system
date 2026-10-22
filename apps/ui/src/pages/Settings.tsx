import { useEffect, useState } from 'react';
import type { ApprovalRequest, AuditEntry } from '@dcc/core';
import { actorName, api, setActorName, type AppSettings } from '../api';
import { Badge, Card, SectionTitle, timeAgo } from '../components';

export default function Settings(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [actor, setActor] = useState(actorName());
  const [message, setMessage] = useState<string | null>(null);
  const [scanRootInput, setScanRootInput] = useState('');
  const [backups, setBackups] = useState<Array<{ file: string; createdAt: string; sizeBytes: number; manifest: Record<string, unknown> }>>([]);
  const [ingestCfg, setIngestCfg] = useState<{ apiUrl: string; authEnv: string; webhookSecretEnv: string } | null>(null);

  const load = () => {
    api.settings().then(setSettings);
    api.approvals().then(setApprovals);
    api.audit().then(setAudit);
    api.backups().then(setBackups).catch(() => setBackups([]));
    api.ingestConfig().then(setIngestCfg).catch(() => setIngestCfg(null));
  };
  useEffect(load, []);

  const decide = async (id: string, decision: 'approved' | 'rejected') => {
    const result = await api.decideApproval(id, decision);
    setMessage(result.ok ? `Approval ${decision}.` : `Failed: ${result.error}`);
    load();
  };

  const toggleGate = async (kind: string, required: boolean) => {
    if (!settings) return;
    const requiredKinds = new Set<string>(settings.approvalPolicy.required);
    if (required) requiredKinds.add(kind); else requiredKinds.delete(kind);
    const next = { ...settings, approvalPolicy: { ...settings.approvalPolicy, required: [...requiredKinds] as never } };
    try {
      const saved = await api.saveSettings(next);
      setSettings(saved);
      setMessage('Policy updated.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
    load();
  };

  if (!settings) return <div className="faint">Loading settings…</div>;

  const pending = approvals.filter((a) => a.status === 'pending');

  return (
    <div>
      <SectionTitle title="Settings, Security & Integrations" hint="least privilege · OS-protected secrets · approval gates · audit trail" />
      {message && <div className="notice ok" style={{ marginBottom: 14 }}>{message}</div>}

      <div className="grid cols-2">
        <Card title="Local configuration">
          <div className="field">
            <label>Operator name (recorded in the audit log)</label>
            <input value={actor} onChange={(e) => setActor(e.target.value)} onBlur={() => setActorName(actor)} />
          </div>
          <div className="field">
            <label>Scan roots (folders searched for Git repositories)</label>
            <div className="row">
              <input
                style={{ flex: 1 }}
                value={scanRootInput}
                onChange={(e) => setScanRootInput(e.target.value)}
                placeholder={settings.scanRoots[0] ?? 'D:\\Development'}
              />
              <button
                className="btn small"
                disabled={!scanRootInput}
                onClick={async () => {
                  const saved = await api.saveSettings({ ...settings, scanRoots: [...settings.scanRoots, scanRootInput] });
                  setSettings(saved);
                  setScanRootInput('');
                }}
              >
                Add root
              </button>
            </div>
            <div className="faint" style={{ marginTop: 6 }}>
              {settings.scanRoots.map((r) => <div key={r} className="mono">{r}</div>)}
            </div>
          </div>
          <div className="field">
            <label>Staleness window (minutes without update = stale)</label>
            <input
              type="number"
              value={settings.staleAfterMinutes}
              onChange={async (e) => {
                const saved = await api.saveSettings({ ...settings, staleAfterMinutes: Number(e.target.value) });
                setSettings(saved);
              }}
            />
          </div>
          <div className="notice">
            Secrets never live in this database. Windows builds use Windows Credential Manager (or the session environment) — nothing is written to prompts, issue bodies, logs, or diagnostic bundles.
          </div>
        </Card>

        <Card title="Approval gates" right={<Badge color={settings.approvalPolicy.required.length > 8 ? 'green' : 'amber'}>{settings.approvalPolicy.required.length} gates active</Badge>}>
          <div className="faint" style={{ marginBottom: 10 }}>
            Removing a gate is a consequential change: it requires an approved <code>policy_change</code> request first.
          </div>
          {['issue_create', 'issue_close', 'issue_comment', 'github_write', 'merge', 'release', 'deploy', 'branch_switch', 'git_destructive', 'external_write', 'llm_send', 'policy_change', 'restore_backup'].map((kind) => {
            const required = settings.approvalPolicy.required.includes(kind as never);
            return (
              <label key={kind} className="row" style={{ justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid rgba(36,50,86,0.5)', cursor: 'pointer' }}>
                <span className="mono">{kind}</span>
                <input type="checkbox" checked={required} onChange={(e) => toggleGate(kind, e.target.checked)} />
              </label>
            );
          })}
        </Card>
      </div>

      <SectionTitle title="Backup & restore / workspace bundles" hint="local-first: the bundle doubles as the multi-device handoff primitive" />
      <div className="grid cols-2">
        <Card title="Backups" right={<button className="btn small primary" onClick={async () => { const b = await api.exportBackup(); setMessage(`Backup exported: ${b.file.split('/').pop()} (${Math.round(b.sizeBytes / 1024)} KB)`); load(); }}>Export now</button>}>
          {backups.length === 0 ? (
            <div className="faint">No backups yet. Exports are consistent SQLite snapshots + a manifest — secrets never live in the database.</div>
          ) : (
            backups.slice(0, 6).map((b) => (
              <div key={b.file} className="row" style={{ justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(36,50,86,0.5)' }}>
                <div>
                  <div className="mono" style={{ fontSize: 11 }}>{b.file.split('/').pop()}</div>
                  <div className="faint">{timeAgo(b.createdAt)} · {Math.round(b.sizeBytes / 1024)} KB · {JSON.stringify(b.manifest.counts ?? {})}</div>
                </div>
                <button
                  className="btn small danger"
                  onClick={async () => {
                    const result = await api.restoreBackup(b.file);
                    if (result.requiresApproval) {
                      setMessage('Restore requires approval — a restore_backup request is now needed in the approval queue before it can run.');
                      const req = await api.approvals().then((all) => all.find((a) => a.kind === 'restore_backup' && a.status === 'pending'));
                      void req;
                    } else {
                      setMessage(result.note ?? result.error ?? 'done');
                    }
                  }}
                >
                  Restore (gated)
                </button>
              </div>
            ))
          )}
          <div className="faint" style={{ marginTop: 8 }}>
            Restore overwrites local state and therefore requires an approved <code>restore_backup</code> request. A worker restart is needed after restore.
          </div>
        </Card>

        <Card title="Biza Miz ingestion config (Phase 2)">
          {ingestCfg && (
            <>
              <div className="field">
                <label>API base URL (empty = unconfigured → manual intake only)</label>
                <input
                  value={ingestCfg.apiUrl}
                  onChange={(e) => setIngestCfg({ ...ingestCfg, apiUrl: e.target.value })}
                  onBlur={async () => { await api.saveIngestConfig(ingestCfg); setMessage('Ingestion config saved (env var names only — no secrets stored).'); }}
                  placeholder="https://support.example.com/api"
                />
              </div>
              <div className="form-row">
                <div className="field">
                  <label>Token env var name</label>
                  <input value={ingestCfg.authEnv} onChange={(e) => setIngestCfg({ ...ingestCfg, authEnv: e.target.value })} />
                </div>
                <div className="field">
                  <label>Webhook secret env var name</label>
                  <input value={ingestCfg.webhookSecretEnv} onChange={(e) => setIngestCfg({ ...ingestCfg, webhookSecretEnv: e.target.value })} />
                </div>
              </div>
              <button className="btn small" onClick={async () => { await api.saveIngestConfig(ingestCfg); const c = await api.ingestCheck(); setMessage(`Connection check: ${c.status} — ${c.notes}`); }}>
                Save & check connection
              </button>
            </>
          )}
        </Card>
      </div>

      <SectionTitle title={`Approval queue (${pending.length} pending)`} hint="owner decides — external writes wait here" />
      <Card>
        {approvals.length === 0 ? (
          <div className="faint">No approval requests.</div>
        ) : (
          <table className="data">
            <thead><tr><th>Request</th><th>Kind</th><th>Status</th><th>Requested</th><th>Decision</th></tr></thead>
            <tbody>
              {approvals.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.title}
                    <div className="faint mono">{JSON.stringify(a.payload).slice(0, 120)}</div>
                  </td>
                  <td><Badge color="purple">{a.kind}</Badge></td>
                  <td>
                    <Badge color={a.status === 'approved' ? 'green' : a.status === 'rejected' ? 'red' : a.status === 'pending' ? 'amber' : 'gray'}>{a.status}</Badge>
                  </td>
                  <td className="faint">{timeAgo(a.createdAt)} by {a.requestedBy}</td>
                  <td>
                    {a.status === 'pending' ? (
                      <div className="row">
                        <button className="btn small success" onClick={() => decide(a.id, 'approved')}>Approve</button>
                        <button className="btn small danger" onClick={() => decide(a.id, 'rejected')}>Reject</button>
                      </div>
                    ) : (
                      <span className="faint">{a.decidedBy ? `by ${a.decidedBy}` : ''} {a.reason ? `· ${a.reason}` : ''}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <SectionTitle title="Audit trail" hint="append-only — user decisions, agent actions, outcomes, timestamps" />
      <Card>
        <div className="log" style={{ maxHeight: 380 }}>
          {audit.map((a) => (
            <div key={a.id} className={a.outcome === 'denied' ? 'ev-error' : a.outcome === 'error' ? 'ev-error' : 'ev-info'}>
              [{a.at.slice(0, 19)}] {a.actor} · {a.action} · {a.targetKind}{a.targetId ? `/${a.targetId.slice(0, 12)}` : ''} · <strong>{a.outcome}</strong>{a.detail ? ` — ${a.detail}` : ''}
            </div>
          ))}
        </div>
      </Card>

      <SectionTitle title="Open verification items" hint="from issue #1 — marked unknown until confirmed" />
      <Card>
        {Object.entries(settings.notes).map(([key, note]) => (
          <div key={key} className="notice warn" style={{ marginBottom: 8 }}>
            <strong className="mono">{key}</strong>: {note}
          </div>
        ))}
      </Card>
    </div>
  );
}
