import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardSummary, Task } from '@dcc/core';
import { api, type EngineeringHealth } from '../api';
import { Badge, Card, EmptyState, SectionTitle, SourcedStatusRow, TaskBadge, timeAgo } from '../components';

export default function CommandCenter(): JSX.Element {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [health, setHealth] = useState<EngineeringHealth | null>(null);
  const [stale, setStale] = useState<Array<{ id: string; kind: string; title: string; staleReason: string; activityStatus: string }>>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    Promise.all([api.dashboard(), api.stale(), api.tasks(), api.engineeringHealth()])
      .then(([d, s, t, h]) => { setData(d); setStale(s); setTasks(t); setHealth(h); setError(null); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => { load(); }, []);

  if (error) return <div className="notice danger">Worker unreachable: {error}. Start the worker with <code>npm run dev:worker</code>.</div>;
  if (!data) return <EmptyState>Loading command center…</EmptyState>;

  const taskEntries = Object.entries(data.tasks);
  const recent = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);

  return (
    <div>
      <SectionTitle
        title="Command Center"
        hint={`generated ${timeAgo(data.generatedAt)} · every value below carries its source`}
        right={<button className="btn small" onClick={load}>Refresh</button>}
      />

      {/* Row 1: headline metrics */}
      <div className="grid cols-4">
        <Card title="Projects & Repositories">
          <div className="metric">{data.projects.total} <span className="faint">projects</span></div>
          <div className="metric-sub">
            {data.repositories.total} repositories · {data.repositories.dirty} with uncommitted changes
            {data.repositories.syncErrors > 0 && <> · <span style={{ color: 'var(--danger)' }}>{data.repositories.syncErrors} sync error(s)</span></>}
          </div>
          <div className="metric-sub">last Git refresh: {timeAgo(data.repositories.lastRefresh)}</div>
        </Card>

        <Card title="GitHub">
          <div className="metric">{data.github.openIssues} <span className="faint">open issues</span></div>
          <div className="metric-sub">{data.github.openPrs} open PRs · {data.github.failingCi} with CI concerns</div>
          <div className="metric-sub">last sync: {timeAgo(data.github.lastSync)}</div>
        </Card>

        <Card title="Agent Runs">
          <div className="metric">{data.runs.active} <span className="faint">active</span></div>
          <div className="metric-sub">
            {data.runs.failed} failed · {data.runs.interrupted} interrupted (recovered)
          </div>
          <div className="metric-sub">providers verified: {data.providers.verified}/{data.providers.total}</div>
        </Card>

        <Card title="Support & Approvals">
          <div className="metric">{data.approvals.pending} <span className="faint">pending approvals</span></div>
          <div className="metric-sub">
            support: {data.support.new} new · {data.support.triaging} triaging · {data.support.linked} linked · {data.support.needsEvidence} need evidence
          </div>
          <div className="metric-sub">{data.staleWork} stale work item(s)</div>
        </Card>
      </div>

      {/* Row 2: work states */}
      <SectionTitle title="Work states" hint="internal task lifecycle — distinct from GitHub/agent/test/PR status" />
      <Card>
        <div className="metric-row">
          {taskEntries.length === 0 && <span className="faint">No tasks yet.</span>}
          {taskEntries.map(([status, n]) => (
            <div className="metric-pill" key={status}>
              <div className="n">{n}</div>
              <div className="l"><TaskBadge status={status} /></div>
            </div>
          ))}
        </div>
        <div className="divider" />
        <table className="data">
          <thead>
            <tr>
              <th>Recently changed work</th>
              <th>Internal</th>
              <th>GitHub</th>
              <th>Agent</th>
              <th>Test</th>
              <th>PR</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((t) => (
              <tr key={t.id}>
                <td><Link to={`/tasks?focus=${t.id}`}>{t.title}</Link></td>
                <td><TaskBadge status={t.internalStatus} /></td>
                <td><Badge color="gray">{t.githubStatus}</Badge></td>
                <td><Badge color={t.agentStatus === 'failing' ? 'red' : t.agentStatus === 'passing' ? 'green' : 'gray'}>{t.agentStatus}</Badge></td>
                <td><Badge color={t.testStatus === 'failing' ? 'red' : t.testStatus === 'passing' ? 'green' : 'gray'}>{t.testStatus}</Badge></td>
                <td><Badge color="gray">{t.prStatus}</Badge></td>
                <td className="faint">{timeAgo(t.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Row 3: evidence-backed status + stale work */}
      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <Card title="Evidence-backed status">
          {data.items.map((item) => <SourcedStatusRow key={item.label} item={item} />)}
          <div className="faint" style={{ marginTop: 10 }}>
            confirmed = read from a real system · inferred = recommendation · stale = older than freshness window · unavailable = integration could not be read
          </div>
        </Card>

        <Card title="Needs attention" right={<Badge color={stale.length > 0 ? 'amber' : 'green'}>{stale.length} items</Badge>}>
          {stale.length === 0 ? (
            <span className="faint">Nothing stale or overdue. Blocked and failed work is listed below.</span>
          ) : (
            <div className="link-list">
              {stale.slice(0, 8).map((s) => (
                <div key={s.id} className="notice warn">
                  <strong>{s.title}</strong>
                  <div className="faint">{s.activityStatus} · {s.staleReason}</div>
                </div>
              ))}
            </div>
          )}
          <div className="divider" />
          <div className="link-list">
            {tasks.filter((t) => ['Blocked', 'Failed'].includes(t.internalStatus)).slice(0, 5).map((t) => (
              <div key={t.id} className={`notice ${t.internalStatus === 'Failed' ? 'danger' : 'warn'}`}>
                <strong>{t.title}</strong>
                <div className="faint">{t.internalStatus} · severity {t.severity} · updated {timeAgo(t.updatedAt)}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Row 4: engineering health + release readiness + discrepancies */}
      {health && (
        <>
          <SectionTitle title="Engineering health" hint="computed from the local evidence store — aggregates are inferred" />
          <div className="grid cols-3">
            <Card title="Delivery">
              <div className="stat-strip">
                <div className="stat-box"><div className="n">{health.cycle.completedTasks}</div><div className="l">completed</div></div>
                <div className="stat-box"><div className="n">{health.cycle.avgCycleHours != null ? `${health.cycle.avgCycleHours}h` : '—'}</div><div className="l">avg cycle time</div></div>
                <div className="stat-box"><div className="n">{Math.round(health.cycle.completionRate * 100)}%</div><div className="l">completion rate</div></div>
              </div>
              <div className="divider" />
              <div className="stat-strip">
                <div className="stat-box"><div className="n">{Math.round(health.runs.successRate * 100)}%</div><div className="l">run success ({health.runs.succeeded}/{health.runs.total})</div></div>
                <div className="stat-box"><div className="n">{health.runs.timeout + health.runs.interrupted}</div><div className="l">timeout + interrupted</div></div>
              </div>
            </Card>

            <Card title="Quality">
              <div className="stat-strip">
                <div className="stat-box"><div className="n">{Math.round(health.quality.evidenceCoverage * 100)}%</div><div className="l">evidence coverage</div></div>
                <div className="stat-box"><div className="n">{health.quality.failingTestTasks}</div><div className="l">failing tests</div></div>
                <div className="stat-box"><div className="n">{health.quality.reviewApprovals}/{health.quality.reviewRequestsChanges}</div><div className="l">review approve / changes</div></div>
              </div>
              <div className="divider" />
              {health.items.map((item) => (
                <SourcedStatusRow
                  key={item.label}
                  item={item as never}
                />
              ))}
            </Card>

            <Card
              title="Release readiness"
              right={<Badge color={health.releaseReadiness.verdict === 'ready' ? 'green' : 'red'} dot>{health.releaseReadiness.verdict}</Badge>}
            >
              <div className="faint">
                {health.releaseReadiness.readyForMerge} task(s) ready for merge · {health.releaseReadiness.ciConcerns} CI concern(s)
              </div>
              <div className="divider" />
              {health.releaseReadiness.releaseBlockers.length === 0 ? (
                <div className="notice ok">No active release blockers detected.</div>
              ) : (
                <div className="link-list">
                  {health.releaseReadiness.releaseBlockers.map((b) => (
                    <div key={b.taskId} className="notice danger">
                      <strong>{b.title}</strong>
                      <div className="faint">{b.reason}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>

          {health.discrepancies.length > 0 && (
            <>
              <SectionTitle title="Status discrepancies" hint="internal state vs GitHub/agent/test/PR tracks — advisory" right={<Badge color="amber">{health.discrepancies.length}</Badge>} />
              <Card>
                {health.discrepancies.slice(0, 6).map((d) => (
                  <div key={`${d.taskId}-${d.code}`} className={`notice ${d.severity === 'high' ? 'danger' : 'warn'}`} style={{ marginBottom: 8 }}>
                    <strong>{d.taskTitle}</strong> <Badge color="purple">{d.code}</Badge>
                    <div className="faint">{d.message}</div>
                  </div>
                ))}
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
