import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { GitState } from '@dcc/core';

const execFileAsync = promisify(execFile);

export interface GitResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function git(repoPath: string, args: string[], timeoutMs = 15_000): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Parse `git status --porcelain=v2 --branch` output into GitState.
 * Pure function — unit tested without touching the filesystem.
 */
export function parseStatusPorcelainV2(stdout: string): GitState {
  const state: GitState = {
    branch: null,
    commitSha: null,
    commitSubject: null,
    dirty: false,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    detached: false,
  };

  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      if (head === '(detached)') {
        state.detached = true;
        state.branch = null;
      } else {
        state.branch = head;
      }
    } else if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      if (oid !== '(initial)') state.commitSha = oid;
    } else if (line.startsWith('# branch.ab ')) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        state.ahead = Number(match[1]);
        state.behind = Number(match[2]);
      }
    } else if (/^[12] /.test(line)) {
      // Ordinary (1) / rename (2) entry: XY staged/unstaged matrix at col 3-4.
      const xy = line.slice(2, 4);
      if (xy[0] !== '.') state.staged += 1;
      if (xy[1] !== '.') state.unstaged += 1;
    } else if (line.startsWith('? ')) {
      state.untracked += 1;
    }
  }

  state.dirty = state.staged + state.unstaged + state.untracked > 0;
  return state;
}

/** Remote URL parsing → GitHub owner/repo when the remote is a GitHub remote. */
export function parseGithubRemote(remoteUrl: string | null): { owner: string; repo: string } | null {
  if (!remoteUrl) return null;
  const patterns = [
    /github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/,
    /github\.com:([^/]+)\/([^/\s]+?)(?:\.git)?$/,
  ];
  for (const pattern of patterns) {
    const match = remoteUrl.trim().match(pattern);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return null;
}

export class GitService {
  /** Never modifies, moves, or checks out anything in the target repository. */
  async captureState(repoPath: string): Promise<GitResult<GitState & { commitSubject: string | null; remoteUrl: string | null }>> {
    if (!fs.existsSync(path.join(repoPath, '.git')) && !fs.existsSync(repoPath)) {
      return { ok: false, error: `Path does not exist: ${repoPath}` };
    }
    try {
      const statusOut = await git(repoPath, ['status', '--porcelain=v2', '--branch']);
      const state = parseStatusPorcelainV2(statusOut);
      if (state.commitSha) {
        try {
          const subject = await git(repoPath, ['log', '-1', '--format=%s']);
          state.commitSubject = subject.trim() || null;
        } catch {
          state.commitSubject = null;
        }
      }
      let remoteUrl: string | null = null;
      try {
        remoteUrl = (await git(repoPath, ['remote', 'get-url', 'origin'])).trim() || null;
      } catch {
        remoteUrl = null;
      }
      return { ok: true, data: { ...state, remoteUrl } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async isGitRepo(dir: string): Promise<boolean> {
    try {
      const out = await git(dir, ['rev-parse', '--is-inside-work-tree']);
      return out.trim() === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Create an isolated worktree for an agent run. The main checkout is never
   * switched or touched — concurrent agents cannot overwrite each other's work.
   */
  async createWorktree(
    repoPath: string,
    worktreePath: string,
    branchName: string,
  ): Promise<GitResult<{ worktreePath: string; branchName: string }>> {
    try {
      await git(repoPath, ['worktree', 'add', '-b', branchName, worktreePath], 60_000);
      return { ok: true, data: { worktreePath, branchName } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async removeWorktree(repoPath: string, worktreePath: string): Promise<GitResult<null>> {
    try {
      await git(repoPath, ['worktree', 'remove', '--force', worktreePath], 60_000);
      return { ok: true, data: null };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listWorktrees(repoPath: string): Promise<GitResult<string[]>> {
    try {
      const out = await git(repoPath, ['worktree', 'list', '--porcelain']);
      const paths = out
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length).trim());
      return { ok: true, data: paths };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async changedFiles(worktreePath: string): Promise<string[]> {
    try {
      const out = await git(worktreePath, ['status', '--porcelain']);
      return out
        .split('\n')
        .filter(Boolean)
        .map((l) => l.slice(3).trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Destructive operations (reset --hard, clean -fd, push --force) are blocked
   * at the API layer behind approval; this helper exists so the guard can be
   * enforced centrally and audited.
   */
  static isDestructiveCommand(args: string[]): boolean {
    const joined = args.join(' ');
    return /(^|\s)(reset\s+--hard|clean\s+-[a-z]*f|push\s+--force|push\s+-f\b|branch\s+-D)/.test(joined);
  }
}
