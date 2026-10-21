import { useEffect, useState } from 'react';
import type { Run, RunEvent } from '@dcc/core';
import { api } from '../api';
import { Badge, Card, EmptyState, SectionTitle, timeAgo } from '../components';

const RUN_COLORS: Record<string, string> = {
  queued: 'gray',
  running: 'blue',
  succeeded: 'green',
  failed: 'red',
  cancelled: 'amber',
  timeout: 'red',
  interrupted: 'amber',
};

export default function Runs(): JSX.Element {
  const [runs, setRuns] = useState<Run[]>([]);
  const [detail, setDetail] = useState<{ run: Run; events: RunEvent[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () => api.runs().then(setRuns);
  useEffect(() => { load(); }, []);

  const openRun = async (id: string) => setDetail(await api.run(id));

  const cancel = async (id: string) => {
    const result = await api.cancelRun(id);
    setMessage(result.ok ? 'Run cancelled.' : `Cancel failed: ${result.error}`);
    load();
    if (detail?.run.id === id) openRun(id);
  };

  return (
    <div>
      <SectionTitle
        title="Runs, Logs & Evidence"
        hint="run state persists across restarts — interrupted runs are visible, never silently successful"
        right={<button className="btn small" onClick={load}>Refresh</button>}
      />
      {message && <div className="notice ok" style={{ marginBottom: 14 }}>{message}</div>}

      <div className="grid cols-2">
        <Card title={`Run history (${runs.length})`}>
          {runs.length === 0 ? (
            <EmptyState>No runs yet.</EmptyState>
          ) : (
            <table className="data">
              <thead><tr><th>Run</th><th>Stage</th><th>Status</th><th>Started</th><th></th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => openRun(r.id)}>
                    <td className="mono">
                      {r.id.slice(0, 14)}…
                      {r.recovered && <Badge color="amber">recovered</Badge>}
                    </td>
                    <td className="faint">{r.stage}</td>
                    <td><Badge color={RUN_COLORS[r.status] ?? 'gray'} dot>{r.status}</Badge></td>
                    <td className="faint">{timeAgo(r.startedAt ?? r.createdAt)}</td>
                    <td>
                      {['queued', 'running'].includes(r.status) && (
                        <button className="btn small danger" onClick={(e) => { e.stopPropagation(); cancel(r.id); }}>Cancel</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title={detail ? `Run ${detail.run.id}` : 'Run detail'}>
          {!detail ? (
            <EmptyState>Select a run to see its event log, worktree, and evidence.</EmptyState>
          ) : (
            <>
              <div className="row wrap">
                <Badge color={RUN_COLORS[detail.run.status] ?? 'gray'} dot>{detail.run.status}</Badge>
                <Badge color="blue">stage: {detail.run.stage}</Badge>
                {detail.run.exitCode != null && <Badge color="gray">exit {detail.run.exitCode}</Badge>}
                {detail.run.recovered && <Badge color="amber">state recovered after restart</Badge>}
              </div>

              <div className="divider" />
              <div className="faint">branch: <span className="mono">{detail.run.branchName ?? '—'}</span></div>
              <div className="faint">worktree: <span className="mono">{detail.run.worktreePath ?? '—'}</span></div>
              <div className="faint">budget: {detail.run.budgetSeconds}s · started {timeAgo(detail.run.startedAt)} · finished {timeAgo(detail.run.finishedAt)}</div>
              {detail.run.changedFiles.length > 0 && (
                <>
                  <div className="faint" style={{ marginTop: 6 }}>changed files ({detail.run.changedFiles.length}):</div>
                  <div className="log" style={{ maxHeight: 100 }}>{detail.run.changedFiles.join('\n')}</div>
                </>
              )}
              {detail.run.error && (
                <div className="notice danger" style={{ marginTop: 8 }}>
                  Failure (shown truthfully): {detail.run.error}
                </div>
              )}

              <div className="divider" />
              <div className="faint">Event log (persisted in local SQLite):</div>
              <div className="log" style={{ marginTop: 6 }}>
                {detail.events.map((e) => (
                  <div key={e.id} className={`ev-${e.kind}`}>
                    [{e.at.slice(11, 19)}] {e.kind.toUpperCase()}: {e.message}
                  </div>
                ))}
              </div>

              <div className="row" style={{ marginTop: 10 }}>
                {['queued', 'running'].includes(detail.run.status) && (
                  <button className="btn small danger" onClick={() => cancel(detail.run.id)}>Cancel run</button>
                )}
                <button className="btn small" onClick={() => openRun(detail.run.id)}>Reload events</button>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
