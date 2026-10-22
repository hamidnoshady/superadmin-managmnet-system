import { useEffect, useState } from 'react';
import type { Provider, Repository, Run, Task, TaskStatus } from '@dcc/core';
import { api } from '../api';
import { Badge, Card, EmptyState, SectionTitle, TaskBadge, timeAgo } from '../components';

const STAGES = [
  { key: 'intake', label: 'Intake', desc: 'Bug/ticket arrives from support, GitHub, or manual entry' },
  { key: 'triage', label: 'Triage', desc: 'Classify severity, module, and possible duplicates (advisory)' },
  { key: 'investigation', label: 'Investigation', desc: 'Inspect authorized code/logs/changes; cite evidence, state uncertainty' },
  { key: 'planning', label: 'Planning', desc: 'Scope, dependencies, risks, steps, acceptance criteria' },
  { key: 'approval', label: 'Human approval', desc: 'Owner approves plan before any consequential implementation' },
  { key: 'implementation', label: 'Implementation', desc: 'Coding agent runs in an isolated branch/worktree' },
  { key: 'testing', label: 'Testing', desc: 'Configured checks run; evidence mapped to acceptance criteria' },
  { key: 'review', label: 'Review', desc: 'Independent assessment of correctness, security, regressions' },
  { key: 'pr', label: 'PR & merge', desc: 'PR preparation, CI monitoring, human-approved merge/release' },
];

export default function Agents(): JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [assign, setAssign] = useState({ taskId: '', providerId: '', repoId: '', stage: 'implementation' });
  const [recs, setRecs] = useState<Array<{ providerId: string; providerName: string; status: string; score: number; rationale: string; eligible: boolean }> | null>(null);
  const [deps, setDeps] = useState<{ dependencies: Array<{ dependsOnTitle: string; dependsOnStatus: string; kind: string }>; unmet: Array<{ dependsOnTitle: string; dependsOnStatus: string }> } | null>(null);
  const [findings, setFindings] = useState<Array<{ id: string; stage: string; kind: string; summary: string; confidence: string; created_at: string }>>([]);
  const [pipelineResult, setPipelineResult] = useState<string | null>(null);

  const load = () => {
    api.tasks().then(setTasks);
    api.providers().then(setProviders);
    api.repositories().then(setRepos);
    api.runs().then(setRuns);
  };
  useEffect(load, []);

  useEffect(() => {
    if (!assign.taskId) { setRecs(null); setDeps(null); setFindings([]); return; }
    api.recommend(assign.taskId).then((r) => setRecs(r.recommendations)).catch(() => setRecs(null));
    api.taskDependencies(assign.taskId).then(setDeps).catch(() => setDeps(null));
    api.taskFindings(assign.taskId).then(setFindings).catch(() => setFindings([]));
  }, [assign.taskId]);

  const startRun = async () => {
    // Coordinator start: conflict + dependency + policy guards run first.
    const result = await api.startGuardedRun({
      taskId: assign.taskId || null,
      providerId: assign.providerId,
      repoId: assign.repoId || null,
      stage: assign.stage,
      maxAttempts: 3,
    });
    if (result.ok) {
      setMessage(`Run ${result.run?.id} queued in an isolated worktree.${result.warnings.length > 0 ? ` Warnings: ${result.warnings.join('; ')}` : ''}`);
      load();
    } else {
      setMessage(`Run not started: ${result.error}`);
    }
  };

  const runPipeline = async () => {
    if (!assign.taskId) return;
    const result = await api.runPipeline({ taskId: assign.taskId, providerId: assign.providerId || null, repoId: assign.repoId || null, autonomyLevel: 1 });
    if (result.ok && result.result) {
      setPipelineResult(
        `Pipeline ${result.result.runId}: ${result.result.stages.map((s) => `${s.stage}=${s.status}`).join(', ')} · ${result.result.findings} finding(s)${result.result.stoppedForApproval ? ' · stopped at approval gate' : ''}`,
      );
      load();
      api.taskFindings(assign.taskId).then(setFindings);
    } else {
      setPipelineResult(`Pipeline failed: ${result.error}`);
    }
  };

  const activeRuns = runs.filter((r) => ['queued', 'running'].includes(r.status));

  return (
    <div>
      <SectionTitle title="AI Brain & Agents" hint="coordinator + specialized roles over a shared, persistent task/evidence graph" />
      {message && <div className="notice ok" style={{ marginBottom: 14 }}>{message}</div>}

      <Card title="Pipeline stages">
        <div className="row wrap" style={{ gap: 8 }}>
          {STAGES.map((s, i) => (
            <div key={s.key} className="stat-box" style={{ minWidth: 150, flex: '1 1 150px' }}>
              <div className="row" style={{ gap: 6 }}>
                <Badge color="blue">{i + 1}</Badge>
                <strong style={{ fontSize: 12.5 }}>{s.label}</strong>
              </div>
              <div className="faint" style={{ marginTop: 4 }}>{s.desc}</div>
            </div>
          ))}
        </div>
        <div className="faint" style={{ marginTop: 10 }}>
          Flow: intake → triage → investigation → plan → <strong>approval</strong> → implementation (isolated worktree) → tests → review → PR → human-approved merge/release.
          Implementation and external writes are approval-gated by default; autonomy only increases through explicit per-project policy.
        </div>
      </Card>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <Card title="Assign a run (coordinator)">
          <div className="field">
            <label>Task</label>
            <select value={assign.taskId} onChange={(e) => setAssign({ ...assign, taskId: e.target.value })}>
              <option value="">(no task — exploratory run)</option>
              {tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          </div>
          <div className="form-row">
            <div className="field">
              <label>Provider (verification status shown)</label>
              <select value={assign.providerId} onChange={(e) => setAssign({ ...assign, providerId: e.target.value })}>
                <option value="">select provider…</option>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name} [{p.status}]</option>)}
              </select>
            </div>
            <div className="field">
              <label>Repository (isolated worktree)</label>
              <select value={assign.repoId} onChange={(e) => setAssign({ ...assign, repoId: e.target.value })}>
                <option value="">(none)</option>
                {repos.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Stage</label>
            <select value={assign.stage} onChange={(e) => setAssign({ ...assign, stage: e.target.value })}>
              {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
          <div className="row wrap">
            <button className="btn primary" disabled={!assign.providerId} onClick={startRun}>Start guarded run</button>
            <button className="btn" disabled={!assign.taskId} onClick={runPipeline}>Run AI pipeline (triage → plan → approval)</button>
          </div>
          {pipelineResult && <div className="notice ok" style={{ marginTop: 10 }}>{pipelineResult}</div>}

          {recs && recs.length > 0 && (
            <>
              <div className="faint" style={{ marginTop: 12 }}>Capability-based recommendations <Badge color="purple">inferred</Badge>:</div>
              <div className="link-list" style={{ marginTop: 6 }}>
                {recs.slice(0, 3).map((r) => (
                  <div key={r.providerId} className="notice">
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <strong>{r.providerName}</strong>
                      <Badge color={r.eligible ? 'green' : 'gray'}>{r.eligible ? 'eligible' : r.status} · score {r.score}</Badge>
                    </div>
                    <div className="faint">{r.rationale}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {deps && deps.dependencies.length > 0 && (
            <>
              <div className="faint" style={{ marginTop: 12 }}>Dependencies:</div>
              {deps.dependencies.map((d, i) => (
                <div key={i} className={`notice ${deps.unmet.some((u) => u.dependsOnTitle === d.dependsOnTitle) ? 'warn' : ''}`} style={{ marginTop: 6 }}>
                  {d.kind}: <strong>{d.dependsOnTitle}</strong> [{d.dependsOnStatus}]
                </div>
              ))}
            </>
          )}

          {findings.length > 0 && (
            <>
              <div className="faint" style={{ marginTop: 12 }}>Shared brain findings (evidence graph):</div>
              <div className="log" style={{ maxHeight: 160, marginTop: 6 }}>
                {findings.slice(0, 12).map((f) => (
                  <div key={f.id} className={f.confidence === 'inferred' ? 'ev-warn' : 'ev-info'}>
                    [{f.stage}/{f.kind}] {f.summary} <span className="faint">({f.confidence})</span>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="faint" style={{ marginTop: 10 }}>
            Guards enforced before every start: no second active run on the same task, overlapping-file warnings across parallel runs, unmet dependencies block implementation, project provider policy respected. Providers that are not verified will fail honestly — they never fake success.
          </div>
        </Card>

        <Card title={`Active runs (${activeRuns.length})`}>
          {activeRuns.length === 0 ? (
            <EmptyState>No active runs. The worker persists run state across restarts.</EmptyState>
          ) : (
            <div className="link-list">
              {activeRuns.map((r) => (
                <div key={r.id} className="notice">
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong className="mono">{r.id}</strong>
                    <Badge color={r.status === 'running' ? 'blue' : 'gray'} dot>{r.status}</Badge>
                  </div>
                  <div className="faint">stage {r.stage} · task {r.taskId ?? '—'} · started {timeAgo(r.startedAt)}</div>
                </div>
              ))}
            </div>
          )}
          <div className="divider" />
          <div className="faint">Concurrency guard: overlapping tasks on the same repository run in separate worktrees, so parallel agents cannot silently overwrite one another's work.</div>
        </Card>
      </div>

      <SectionTitle title="Task board" hint="internal lifecycle — Blocked/Failed are first-class states" />
      <Card>
        <table className="data">
          <thead><tr><th>Task</th><th>Status</th><th>Severity</th><th>Tracks (github / agent / test / pr)</th><th>Updated</th></tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td>{t.title}</td>
                <td><TaskBadge status={t.internalStatus as TaskStatus} /></td>
                <td><Badge color={t.severity === 'critical' || t.severity === 'high' ? 'red' : 'gray'}>{t.severity}</Badge></td>
                <td className="faint">{t.githubStatus} / {t.agentStatus} / {t.testStatus} / {t.prStatus}</td>
                <td className="faint">{timeAgo(t.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
