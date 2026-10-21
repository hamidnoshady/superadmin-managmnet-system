import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitService, parseStatusPorcelainV2, parseGithubRemote } from '../src/services/git.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

describe('parseStatusPorcelainV2 (pure)', () => {
  it('parses branch, upstream ahead/behind, and change counts', () => {
    const stdout = [
      '# branch.oid 1234567890abcdef1234567890abcdef12345678',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaaa bbbb file-a.ts',
      '1 M. N... 100644 100644 100644 cccc dddd file-b.ts',
      '2 R. N... 100644 100644 100644 eeee ffff new.ts\told.ts',
      '? untracked.md',
    ].join('\n');
    const state = parseStatusPorcelainV2(stdout);
    expect(state.branch).toBe('main');
    expect(state.commitSha).toBe('1234567890abcdef1234567890abcdef12345678');
    expect(state.ahead).toBe(2);
    expect(state.behind).toBe(1);
    expect(state.staged).toBe(2); // file-b + rename
    expect(state.unstaged).toBe(1); // file-a
    expect(state.untracked).toBe(1);
    expect(state.dirty).toBe(true);
    expect(state.detached).toBe(false);
  });

  it('parses a clean repo and detached HEAD', () => {
    const clean = parseStatusPorcelainV2('# branch.oid abc\n# branch.head main\n');
    expect(clean.dirty).toBe(false);
    expect(clean.branch).toBe('main');

    const detached = parseStatusPorcelainV2('# branch.oid abc\n# branch.head (detached)\n');
    expect(detached.detached).toBe(true);
    expect(detached.branch).toBeNull();
  });
});

describe('parseGithubRemote', () => {
  it('parses ssh and https GitHub remotes', () => {
    expect(parseGithubRemote('git@github.com:hamidnoshady/superadmin-managmnet-system.git')).toEqual({
      owner: 'hamidnoshady', repo: 'superadmin-managmnet-system',
    });
    expect(parseGithubRemote('https://github.com/hamidnoshady/superadmin-managmnet-system.git')).toEqual({
      owner: 'hamidnoshady', repo: 'superadmin-managmnet-system',
    });
    expect(parseGithubRemote('https://example.com/not-github.git')).toBeNull();
    expect(parseGithubRemote(null)).toBeNull();
  });
});

describe('GitService against a real temporary repository', () => {
  let dir: string;
  const svc = new GitService();

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcc-git-'));
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'initial commit');
    git(dir, 'remote', 'add', 'origin', 'https://github.com/example/demo.git');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('captures real git state without modifying the repository', async () => {
    const result = await svc.captureState(dir);
    expect(result.ok).toBe(true);
    expect(result.data?.branch).toBe('main');
    expect(result.data?.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.data?.commitSubject).toBe('initial commit');
    expect(result.data?.dirty).toBe(false);
    expect(result.data?.remoteUrl).toContain('github.com/example/demo.git');
    // The repo must be untouched: still on main with a clean tree.
    expect(git(dir, 'branch', '--show-current').trim()).toBe('main');
  });

  it('reports uncommitted changes truthfully', async () => {
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');
    const result = await svc.captureState(dir);
    expect(result.data?.dirty).toBe(true);
    expect(result.data?.untracked).toBe(1);
  });

  it('creates and removes isolated worktrees without touching the main checkout', async () => {
    const wt = path.join(dir, '..', `wt-${Date.now()}`);
    const created = await svc.createWorktree(dir, wt, 'agent/test-branch');
    expect(created.ok).toBe(true);
    expect(fs.existsSync(path.join(wt, '.git')) || fs.existsSync(wt)).toBe(true);
    // Main checkout still on its own branch.
    expect(git(dir, 'branch', '--show-current').trim()).toBe('main');

    const listed = await svc.listWorktrees(dir);
    expect(listed.data?.length).toBeGreaterThanOrEqual(2);

    const removed = await svc.removeWorktree(dir, wt);
    expect(removed.ok).toBe(true);
  });

  it('rejects non-repositories clearly', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dcc-nogit-'));
    const result = await svc.captureState(empty);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it('flags destructive git commands for approval', () => {
    expect(GitService.isDestructiveCommand(['reset', '--hard'])).toBe(true);
    expect(GitService.isDestructiveCommand(['clean', '-fd'])).toBe(true);
    expect(GitService.isDestructiveCommand(['push', '--force'])).toBe(true);
    expect(GitService.isDestructiveCommand(['branch', '-D', 'x'])).toBe(true);
    expect(GitService.isDestructiveCommand(['status'])).toBe(false);
    expect(GitService.isDestructiveCommand(['commit', '-m', 'cleanup'])).toBe(false);
  });
});
