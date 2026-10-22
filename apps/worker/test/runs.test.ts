import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServices, type AppServices } from '../src/services/seed.js';
import { removeTempDir } from './helpers.js';

let tmp: string;
let services: AppServices;
let repoPath: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

const waitFor = async (fn: () => boolean, timeoutMs = 5000): Promise<void> => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcc-runs-'));
  services = createServices(path.join(tmp, 'test.sqlite'));

  repoPath = path.join(tmp, 'repo');
  fs.mkdirSync(repoPath);
  git(repoPath, 'init', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'test@example.com');
  git(repoPath, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repoPath, 'app.txt'), 'hello\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-m', 'init');
});

afterEach(async () => {
  services.db.close();
  await removeTempDir(tmp);
});

describe('run monitor', () => {
  it('generic CLI runs produce real git evidence and persist changed files', async () => {
    const reg = await services.registry.registerRepository({ localPath: repoPath, name: 'demo-repo' }, 'tester');
    const repo = reg.repo!;
    const provider = services.providers.getByKey('generic-cli')!;
    const task = services.tasks.create({ title: 'Inspect repo state' }, 'tester');

    const started = await services.runs.start({ taskId: task.id, providerId: provider.id, repoId: repo.id, stage: 'investigation' }, 'tester');
    expect(started.ok).toBe(true);

    await waitFor(() => services.runs.get(started.run!.id)?.status === 'succeeded');

    const run = services.runs.get(started.run!.id)!;
    expect(run.status).toBe('succeeded');
    expect(run.exitCode).toBe(0);
    expect(run.branchName).toBeTruthy();
    expect(run.worktreePath).toBeTruthy();

    const events = services.runs.listEvents(run.id);
    expect(events.some((e) => e.kind === 'evidence')).toBe(true);

    const evidence = services.tasks.listEvidence(task.id);
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence[0].kind).toBe('git_snapshot');
    expect(services.tasks.get(task.id)?.agentStatus).toBe('passing');
  });

  it('unverified providers fail honestly — never fake success', async () => {
    const provider = services.providers.getByKey('claude-code')!;
    const task = services.tasks.create({ title: 'Coding run' }, 'tester');

    const started = await services.runs.start({ taskId: task.id, providerId: provider.id }, 'tester');
    await waitFor(() => ['failed', 'succeeded'].includes(services.runs.get(started.run!.id)?.status ?? ''));

    const run = services.runs.get(started.run!.id)!;
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/not verified/i);
    expect(services.tasks.get(task.id)?.agentStatus).toBe('failing');
  });

  it('recovers interrupted runs after a crash/restart', async () => {
    const provider = services.providers.getByKey('generic-cli')!;
    const task = services.tasks.create({ title: 'Long run' }, 'tester');
    const started = await services.runs.start({ taskId: task.id, providerId: provider.id, repoId: null }, 'tester');

    // Simulate a crash mid-run: force status back to running, then "restart".
    services.db.run(`UPDATE runs SET status = 'running' WHERE id = ?`, started.run!.id);
    const dbPath = services.db.filePath;
    services.db.close();

    services = createServices(dbPath);
    const recovered = services.runs.recoverInterruptedRuns();
    expect(recovered).toBe(1);

    const run = services.runs.get(started.run!.id)!;
    expect(run.status).toBe('interrupted');
    expect(run.recovered).toBe(true);
    expect(run.error).toMatch(/restart/i);

    const events = services.runs.listEvents(run.id);
    expect(events.some((e) => e.message.match(/recovered/i))).toBe(true);
  });

  it('cancels queued/running runs and refuses finished ones', async () => {
    const provider = services.providers.getByKey('generic-cli')!;
    const started = await services.runs.start({ taskId: null, providerId: provider.id, repoId: null }, 'tester');
    services.db.run(`UPDATE runs SET status = 'running' WHERE id = ?`, started.run!.id);

    const cancelled = await services.runs.cancel(started.run!.id, 'tester');
    expect(cancelled.ok).toBe(true);
    expect(services.runs.get(started.run!.id)?.status).toBe('cancelled');

    const again = await services.runs.cancel(started.run!.id, 'tester');
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/finished/);
  });

  it('provider checks only mark verified when the execution path works', async () => {
    const cli = services.providers.getByKey('generic-cli')!;
    const checked = await services.providers.check(cli.id, 'tester');
    expect(checked?.status).toBe('verified');

    const arena = services.providers.getByKey('arena-ai')!;
    const arenaChecked = await services.providers.check(arena.id, 'tester');
    expect(arenaChecked?.status).toBe('unknown');

    const freebuf = services.providers.getByKey('freebuf')!;
    expect(freebuf.status).toBe('unknown');
    expect(freebuf.checkNotes).toMatch(/UNKNOWN IDENTITY/i);
    expect(freebuf.enabled).toBe(false);
  });
});
