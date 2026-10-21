import { useEffect, useState } from 'react';
import type { GithubIssue, GithubPullRequest, Repository, Task } from '@dcc/core';
import { api } from '../api';
import { Badge, Card, EmptyState, SectionTitle, timeAgo } from '../components';

export default function GitHubOps(): JSX.Element {
  const [repos, setRepos] = useState<Repository[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [issues, setIssues] = useState<GithubIssue[]>([]);
  const [pulls, setPulls] = useState<GithubPullRequest[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [auth, setAuth] = useState<{ available: boolean; method: string; notes: string; checkedAt: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: '', body: '' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.repositories().then((r) => {
      setRepos(r);
      if (r.length > 0 && !selected) setSelected(r[0].id);
    });
    api.tasks().then(setTasks);
    api.githubAuth().then(setAuth);
  }, []);

  useEffect(() => {
    if (!selected) return;
    api.githubIssues(selected).then(setIssues);
    api.githubPulls(selected).then(setPulls);
  }, [selected]);

  const sync = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await api.githubSync(selected);
      setMessage(result.ok ? `Synced ${result.issues} issues and ${result.prs} PRs (source: GitHub API)` : `Sync failed: ${result.error}`);
      if (result.ok) {
        setIssues(await api.githubIssues(selected));
        setPulls(await api.githubPulls(selected));
      }
    } finally {
      setBusy(false);
    }
  };

  const createDraft = async () => {
    const result = await api.createIssueDraft({ title: draft.title, body: draft.body, repoId: selected, labels: ['draft'] });
    setMessage(`Draft saved. Creating the actual GitHub issue requires approval (request ${result.approval.id} is now pending).`);
    setDraft({ title: '', body: '' });
  };

  return (
    <div>
      <SectionTitle
        title="GitHub Operations"
        hint="GitHub is the source of truth for issues/PRs — internal task state stays separate"
        right={
          <div className="row">
            <select value={selected ?? ''} onChange={(e) => setSelected(e.target.value)} style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-panel-2)', color: 'var(--text)' }}>
              {repos.map((r) => <option key={r.id} value={r.id}>{r.name}{r.githubOwner ? ` (${r.githubOwner}/${r.githubRepo})` : ''}</option>)}
            </select>
            <button className="btn primary small" onClick={sync} disabled={!selected || busy}>{busy ? 'Syncing…' : 'Sync from GitHub'}</button>
          </div>
        }
      />

      {message && <div className="notice ok" style={{ marginBottom: 14 }}>{message}</div>}

      <div className="grid cols-2">
        <Card title="Connection status">
          {auth ? (
            <>
              <div className="row">
                {auth.available
                  ? <Badge color="green" dot>connected via {auth.method}</Badge>
                  : <Badge color="red" dot>unavailable</Badge>}
                <span className="faint">checked {timeAgo(auth.checkedAt)}</span>
              </div>
              <div className="faint" style={{ marginTop: 8 }}>{auth.notes}</div>
              {!auth.available && (
                <div className="notice danger" style={{ marginTop: 10 }}>
                  GitHub features are disabled and shown as unavailable — never as healthy. Run <code>gh auth login</code> to connect.
                </div>
              )}
            </>
          ) : <span className="faint">Checking authentication…</span>}
        </Card>

        <Card title="Issue draft composer">
          <div className="field">
            <label>Title</label>
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="[Module] Short summary" />
          </div>
          <div className="field">
            <label>Body (context, impact, reproduction, acceptance criteria)</label>
            <textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder="## Context&#10;…&#10;## Acceptance criteria&#10;- [ ] …" />
          </div>
          <button className="btn primary" disabled={!draft.title || !draft.body} onClick={createDraft}>Save draft + request approval</button>
          <div className="faint" style={{ marginTop: 8 }}>
            Drafts never publish themselves. Creating an issue is an external write and requires explicit owner approval.
          </div>
        </Card>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <Card title={`Synced issues (${issues.length})`}>
          {issues.length === 0 ? (
            <EmptyState>No issues synced yet{selected ? ' for this repository' : ''}. Use “Sync from GitHub”.</EmptyState>
          ) : (
            <table className="data">
              <thead><tr><th>#</th><th>Title</th><th>State</th><th>Labels</th><th>Updated</th></tr></thead>
              <tbody>
                {issues.map((issue) => (
                  <tr key={issue.id}>
                    <td><a href={issue.url} target="_blank" rel="noreferrer">#{issue.number}</a></td>
                    <td>{issue.title}</td>
                    <td><Badge color={issue.state === 'open' ? 'green' : 'gray'}>{issue.state}</Badge></td>
                    <td>{issue.labels.map((l) => <Badge key={l} color="purple">{l}</Badge>)}</td>
                    <td className="faint">{timeAgo(issue.updatedAt)}<span className="source-tag">github_api</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title={`Pull requests (${pulls.length})`}>
          {pulls.length === 0 ? (
            <EmptyState>No pull requests synced yet.</EmptyState>
          ) : (
            <table className="data">
              <thead><tr><th>#</th><th>Title</th><th>State</th><th>CI / Review</th><th>Updated</th></tr></thead>
              <tbody>
                {pulls.map((pr) => (
                  <tr key={pr.id}>
                    <td><a href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a></td>
                    <td>{pr.title}{pr.draft && <Badge color="amber">draft</Badge>}</td>
                    <td><Badge color={pr.state === 'merged' ? 'purple' : pr.state === 'open' ? 'green' : 'gray'}>{pr.state}</Badge></td>
                    <td className="faint">{pr.ciStatus ?? '—'} · review: {pr.reviewDecision ?? '—'}</td>
                    <td className="faint">{timeAgo(pr.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <SectionTitle title="Task ↔ GitHub links" hint="internal tasks linked to GitHub issues/PRs" />
      <Card>
        <table className="data">
          <thead><tr><th>Task</th><th>Internal status</th><th>GitHub status</th><th>Source</th></tr></thead>
          <tbody>
            {tasks.filter((t) => t.githubStatus !== 'unknown' || t.source === 'github_issue').map((t) => (
              <tr key={t.id}>
                <td>{t.title}</td>
                <td><Badge color="blue">{t.internalStatus}</Badge></td>
                <td><Badge color="gray">{t.githubStatus}</Badge></td>
                <td className="faint">{t.source}{t.sourceRef ? ` (${t.sourceRef})` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
