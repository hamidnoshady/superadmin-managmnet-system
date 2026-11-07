import { useEffect, useState } from 'react';
import type { Project, Repository } from '@dcc/core';
import { api } from '../api';
import { Badge, Card, EmptyState, SectionTitle, shortSha, timeAgo } from '../components';

export default function Projects(): JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [scanResults, setScanResults] = useState<{ found: Array<{ path: string; isRegistered: boolean }>; errors: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [newProject, setNewProject] = useState({ name: '', description: '', rootPath: '' });
  const [newRepoPath, setNewRepoPath] = useState('');

  const load = () => {
    Promise.all([api.projects(), api.repositories()]).then(([p, r]) => { setProjects(p); setRepos(r); });
  };
  useEffect(load, []);

  const registerRepo = async () => {
    setBusy(true);
    try {
      const result = await api.registerRepository({ localPath: newRepoPath });
      setMessage(result.ok ? `Registered ${result.repo?.name}` : `Failed: ${result.error}`);
      if (result.ok) setNewRepoPath('');
      load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const refreshRepo = async (id: string) => {
    const result = await api.refreshRepo(id);
    setMessage(result.ok ? 'Git state refreshed from real Git data' : `Refresh failed: ${result.error}`);
    load();
  };

  const runScan = async () => {
    setBusy(true);
    try {
      setScanResults(await api.scan());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <SectionTitle
        title="Projects & Repositories"
        hint="discovery never moves or modifies repositories — Git state is read-only evidence"
        right={<button className="btn small" onClick={runScan} disabled={busy}>{busy ? 'Scanning…' : 'Scan for repositories'}</button>}
      />

      {message && <div className="notice ok" style={{ marginBottom: 14 }}>{message}</div>}

      <div className="grid cols-2">
        <Card title="Register a local project">
          <div className="form-row">
            <div className="field">
              <label>Project name</label>
              <input value={newProject.name} onChange={(e) => setNewProject({ ...newProject, name: e.target.value })} placeholder="Biza Miz Superadmin" />
            </div>
            <div className="field">
              <label>Root path</label>
              <input value={newProject.rootPath} onChange={(e) => setNewProject({ ...newProject, rootPath: e.target.value })} placeholder="D:\Development\..." />
            </div>
          </div>
          <div className="field">
            <label>Description</label>
            <input value={newProject.description} onChange={(e) => setNewProject({ ...newProject, description: e.target.value })} placeholder="What this project covers" />
          </div>
          <button
            className="btn primary"
            disabled={!newProject.name}
            onClick={async () => {
              await api.createProject(newProject);
              setNewProject({ name: '', description: '', rootPath: '' });
              setMessage('Project created');
              load();
            }}
          >
            Create project
          </button>
        </Card>

        <Card title="Register a Git repository">
          <div className="field">
            <label>Local path (must be an existing Git repository)</label>
            <input value={newRepoPath} onChange={(e) => setNewRepoPath(e.target.value)} placeholder="/home/user/projects/my-repo or D:\Development\my-repo" />
          </div>
          <button className="btn primary" disabled={!newRepoPath || busy} onClick={registerRepo}>Register repository</button>
          <div className="faint" style={{ marginTop: 10 }}>
            The repository is only read from. Registration captures branch, commit, dirty state and remote — nothing is written to the checkout.
          </div>
        </Card>
      </div>

      {scanResults && (
        <>
          <SectionTitle title="Scan results" hint="from configured scan roots" />
          <Card>
            {scanResults.errors.length > 0 && (
              <div className="notice warn" style={{ marginBottom: 10 }}>{scanResults.errors.join(' · ')}</div>
            )}
            {scanResults.found.length === 0 ? (
              <EmptyState>No Git repositories found under the configured scan roots.</EmptyState>
            ) : (
              <table className="data">
                <thead><tr><th>Path</th><th>Status</th></tr></thead>
                <tbody>
                  {scanResults.found.map((f) => (
                    <tr key={f.path}>
                      <td className="mono">{f.path}</td>
                      <td>{f.isRegistered ? <Badge color="green">registered</Badge> : <Badge color="blue">not registered</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}

      <SectionTitle title={`Registered repositories (${repos.length})`} hint="branch, commit and dirty state come from actual Git data" />
      {repos.length === 0 ? (
        <EmptyState>No repositories registered yet. Register one above or run a scan.</EmptyState>
      ) : (
        <div className="grid cols-2">
          {repos.map((repo) => (
            <Card key={repo.id} title={repo.name} right={<button className="btn small" onClick={() => refreshRepo(repo.id)}>Refresh Git state</button>}>
              <div className="mono faint">{repo.localPath}</div>
              {repo.gitState ? (
                <>
                  <div className="row wrap" style={{ margin: '10px 0' }}>
                    <Badge color="blue">branch: {repo.gitState.branch ?? '(detached)'}</Badge>
                    <Badge color="gray">commit {shortSha(repo.gitState.commitSha)}</Badge>
                    {repo.gitState.dirty
                      ? <Badge color="amber" dot>uncommitted changes ({repo.gitState.staged} staged / {repo.gitState.unstaged} modified / {repo.gitState.untracked} untracked)</Badge>
                      : <Badge color="green" dot>working tree clean</Badge>}
                    {(repo.gitState.ahead > 0 || repo.gitState.behind > 0) && (
                      <Badge color="purple">ahead {repo.gitState.ahead} / behind {repo.gitState.behind}</Badge>
                    )}
                  </div>
                  <div className="faint">captured {timeAgo(repo.gitStateCapturedAt)} · source: git</div>
                  {repo.gitState.dirty && (
                    <div className="notice warn" style={{ marginTop: 8 }}>
                      ⚠ This checkout has uncommitted changes. Branch switches and destructive Git operations are blocked without explicit approval.
                    </div>
                  )}
                </>
              ) : (
                <div className="notice danger" style={{ marginTop: 10 }}>
                  Git state unavailable: {repo.gitStateError ?? 'not yet captured'}
                </div>
              )}
              <div className="divider" />
              <div className="faint">
                remote: <span className="mono">{repo.remoteUrl ?? 'none'}</span>
                {repo.githubOwner && <> · GitHub: {repo.githubOwner}/{repo.githubRepo}</>}
                {repo.githubSyncError && <span style={{ color: 'var(--danger)' }}> · GitHub sync error: {repo.githubSyncError}</span>}
              </div>
            </Card>
          ))}
        </div>
      )}

      <SectionTitle title={`Projects (${projects.length})`} />
      {projects.length === 0 ? (
        <EmptyState>No projects yet.</EmptyState>
      ) : (
        <div className="grid cols-3">
          {projects.map((p) => (
            <Card key={p.id} title={p.name}>
              <div className="faint">{p.description || 'No description'}</div>
              <div className="divider" />
              <div className="faint">root: <span className="mono">{p.rootPath ?? '—'}</span></div>
              <div className="faint">test command: <span className="mono">{p.testCommand ?? '—'}</span></div>
              <div className="row wrap" style={{ marginTop: 8 }}>
                <Badge color={p.agentPolicy.allowUnattendedWrites ? 'amber' : 'green'}>
                  {p.agentPolicy.allowUnattendedWrites ? 'unattended writes allowed' : 'writes require approval'}
                </Badge>
                <Badge color="gray">run budget {p.agentPolicy.maxRunMinutes}m</Badge>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
