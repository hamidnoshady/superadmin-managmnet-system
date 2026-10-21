import fs from 'node:fs';
import path from 'node:path';
import type { GitState, Project, Repository, AgentPolicy } from '@dcc/core';
import { Database, newId, nowIso } from '../db/database.js';
import { GitService, parseGithubRemote } from './git.js';
import type { AuditService } from './audit.js';

const DEFAULT_AGENT_POLICY: AgentPolicy = {
  allowUnattendedWrites: false,
  allowTerminal: true,
  maxRunMinutes: 30,
  allowedProviders: [],
};

export class RegistryService {
  readonly git = new GitService();

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  // ---- Projects ------------------------------------------------------------

  listProjects(): Project[] {
    return this.db.query<Record<string, unknown>>('SELECT * FROM projects ORDER BY name').map(toProject);
  }

  getProject(id: string): Project | undefined {
    const row = this.db.queryOne<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', id);
    return row ? toProject(row) : undefined;
  }

  createProject(input: Partial<Project> & { name: string }, actor: string): Project {
    const now = nowIso();
    const project: Project = {
      id: newId('prj'),
      name: input.name,
      description: input.description ?? '',
      rootPath: input.rootPath ?? null,
      instructions: input.instructions ?? '',
      buildCommand: input.buildCommand ?? null,
      testCommand: input.testCommand ?? null,
      agentPolicy: { ...DEFAULT_AGENT_POLICY, ...(input.agentPolicy ?? {}) },
      createdAt: now,
      updatedAt: now,
    };
    this.db.run(
      `INSERT INTO projects (id, name, description, root_path, instructions, build_command, test_command, agent_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      project.id, project.name, project.description, project.rootPath, project.instructions,
      project.buildCommand, project.testCommand, JSON.stringify(project.agentPolicy), now, now,
    );
    this.audit.record({ actor, action: 'project.create', targetKind: 'project', targetId: project.id, outcome: 'ok', detail: project.name });
    return project;
  }

  updateProject(id: string, patch: Partial<Project>, actor: string): Project | undefined {
    const current = this.getProject(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.db.run(
      `UPDATE projects SET name = ?, description = ?, root_path = ?, instructions = ?, build_command = ?, test_command = ?, agent_policy = ?, updated_at = ?
       WHERE id = ?`,
      next.name, next.description, next.rootPath, next.instructions, next.buildCommand, next.testCommand,
      JSON.stringify(next.agentPolicy), next.updatedAt, id,
    );
    this.audit.record({ actor, action: 'project.update', targetKind: 'project', targetId: id, outcome: 'ok' });
    return next;
  }

  // ---- Repositories --------------------------------------------------------

  listRepositories(): Repository[] {
    return this.db.query<Record<string, unknown>>('SELECT * FROM repositories ORDER BY name').map(toRepository);
  }

  getRepository(id: string): Repository | undefined {
    const row = this.db.queryOne<Record<string, unknown>>('SELECT * FROM repositories WHERE id = ?', id);
    return row ? toRepository(row) : undefined;
  }

  /**
   * Register a local repository. Discovery NEVER moves, renames, or modifies
   * the target — we only read Git metadata.
   */
  async registerRepository(input: { localPath: string; projectId?: string | null; name?: string }, actor: string): Promise<{ ok: boolean; repo?: Repository; error?: string }> {
    const localPath = path.resolve(input.localPath);
    const isRepo = await this.git.isGitRepo(localPath);
    if (!isRepo) {
      this.audit.record({ actor, action: 'repo.register', targetKind: 'repository', outcome: 'error', detail: `Not a git repository: ${localPath}` });
      return { ok: false, error: `Not a git repository: ${localPath}` };
    }

    const existing = this.db.queryOne<{ id: string }>('SELECT id FROM repositories WHERE local_path = ?', localPath);
    if (existing) {
      return { ok: false, error: `Repository already registered: ${localPath}` };
    }

    const state = await this.git.captureState(localPath);
    const gh = parseGithubRemote(state.data?.remoteUrl ?? null);
    const repo: Repository = {
      id: newId('repo'),
      projectId: input.projectId ?? null,
      name: input.name ?? path.basename(localPath),
      localPath,
      remoteUrl: state.data?.remoteUrl ?? null,
      githubOwner: gh?.owner ?? null,
      githubRepo: gh?.repo ?? null,
      defaultBranch: state.ok ? state.data?.branch ?? null : null,
      gitState: state.ok ? extractGitState(state.data!) : null,
      gitStateCapturedAt: state.ok ? nowIso() : null,
      gitStateError: state.ok ? null : state.error ?? 'unknown error',
      lastGithubSyncAt: null,
      githubSyncError: null,
      createdAt: nowIso(),
    };
    this.db.run(
      `INSERT INTO repositories (id, project_id, name, local_path, remote_url, github_owner, github_repo, default_branch, git_state, git_state_captured_at, git_state_error, last_github_sync_at, github_sync_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      repo.id, repo.projectId, repo.name, repo.localPath, repo.remoteUrl, repo.githubOwner, repo.githubRepo,
      repo.defaultBranch, repo.gitState ? JSON.stringify(repo.gitState) : null,
      repo.gitStateCapturedAt, repo.gitStateError, repo.lastGithubSyncAt, repo.githubSyncError, repo.createdAt,
    );
    this.audit.record({ actor, action: 'repo.register', targetKind: 'repository', targetId: repo.id, outcome: 'ok', detail: localPath });
    return { ok: true, repo };
  }

  /** Refresh real Git state (branch, commit, dirty, ahead/behind) as evidence. */
  async refreshGitState(repoId: string, actor: string): Promise<{ ok: boolean; state?: GitState; error?: string }> {
    const repo = this.getRepository(repoId);
    if (!repo) return { ok: false, error: 'Repository not found' };

    const result = await this.git.captureState(repo.localPath);
    if (!result.ok) {
      this.db.run('UPDATE repositories SET git_state_error = ? WHERE id = ?', result.error ?? 'unknown error', repoId);
      this.audit.record({ actor, action: 'repo.git_refresh', targetKind: 'repository', targetId: repoId, outcome: 'error', detail: result.error ?? null });
      return { ok: false, error: result.error };
    }

    const state = extractGitState(result.data!);
    const gh = parseGithubRemote(result.data!.remoteUrl);
    this.db.run(
      `UPDATE repositories SET git_state = ?, git_state_captured_at = ?, git_state_error = NULL, remote_url = ?, github_owner = ?, github_repo = ? WHERE id = ?`,
      JSON.stringify(state), nowIso(), result.data!.remoteUrl, gh?.owner ?? null, gh?.repo ?? null, repoId,
    );
    this.audit.record({ actor, action: 'repo.git_refresh', targetKind: 'repository', targetId: repoId, outcome: 'ok', detail: `branch=${state.branch ?? 'detached'} dirty=${state.dirty}` });
    return { ok: true, state };
  }

  /**
   * Scan configured folder roots for Git repositories without touching them.
   * Depth-limited, read-only discovery.
   */
  scanRoots(roots: string[], maxDepth = 3): { found: Array<{ path: string; isRegistered: boolean }>; errors: string[] } {
    const found: Array<{ path: string; isRegistered: boolean }> = [];
    const errors: string[] = [];
    const registered = new Set(this.listRepositories().map((r) => r.localPath));

    for (const root of roots) {
      const abs = path.resolve(root);
      if (!fs.existsSync(abs)) {
        errors.push(`Scan root does not exist: ${abs}`);
        continue;
      }
      this.walk(abs, maxDepth, 0, found, registered, errors);
    }
    this.audit.record({ actor: 'user:scan', action: 'repo.scan', targetKind: 'settings', outcome: errors.length > 0 ? 'error' : 'ok', detail: `Found ${found.length} repositories across ${roots.length} roots` });
    return { found, errors };
  }

  private walk(dir: string, maxDepth: number, depth: number, found: Array<{ path: string; isRegistered: boolean }>, registered: Set<string>, errors: string[]): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      errors.push(`Cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      found.push({ path: dir, isRegistered: registered.has(dir) });
      return; // do not descend into a repo
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
      this.walk(path.join(dir, entry.name), maxDepth, depth + 1, found, registered, errors);
    }
  }
}

function extractGitState(data: GitState & { commitSubject: string | null }): GitState {
  return {
    branch: data.branch,
    commitSha: data.commitSha,
    commitSubject: data.commitSubject,
    dirty: data.dirty,
    staged: data.staged,
    unstaged: data.unstaged,
    untracked: data.untracked,
    ahead: data.ahead,
    behind: data.behind,
    detached: data.detached,
  };
}

function toProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ''),
    rootPath: (row.root_path as string) ?? null,
    instructions: String(row.instructions ?? ''),
    buildCommand: (row.build_command as string) ?? null,
    testCommand: (row.test_command as string) ?? null,
    agentPolicy: JSON.parse(String(row.agent_policy ?? '{}')),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRepository(row: Record<string, unknown>): Repository {
  return {
    id: String(row.id),
    projectId: (row.project_id as string) ?? null,
    name: String(row.name),
    localPath: String(row.local_path),
    remoteUrl: (row.remote_url as string) ?? null,
    githubOwner: (row.github_owner as string) ?? null,
    githubRepo: (row.github_repo as string) ?? null,
    defaultBranch: (row.default_branch as string) ?? null,
    gitState: row.git_state ? JSON.parse(String(row.git_state)) : null,
    gitStateCapturedAt: (row.git_state_captured_at as string) ?? null,
    gitStateError: (row.git_state_error as string) ?? null,
    lastGithubSyncAt: (row.last_github_sync_at as string) ?? null,
    githubSyncError: (row.github_sync_error as string) ?? null,
    createdAt: String(row.created_at),
  };
}
