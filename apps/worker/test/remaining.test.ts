/**
 * Remaining-phase verification (issue #1): agent adapters, LLM assist with
 * outbound redaction, secrets store, remote sync, CI-check mapping, resolution
 * sync-back, autonomy >= 2 flow, and task-state walker honesty.
 *
 * Fake `claude`/`codex` binaries stand in for the real CLIs (which cannot be
 * authenticated inside this environment). The adapters themselves, the
 * evidence pipeline, and every honesty contract under test are the real code.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServices, type AppServices } from '../src/services/seed.js';
import { GithubService } from '../src/services/github.js';
import { SecretStore } from '../src/services/secrets.js';
import { LlmClient } from '../src/services/llm.js';
import { ClaudeCodeAdapter, CodexAdapter, HttpApiAdapter } from '../src/services/agentAdapters.js';
import { RemoteSyncService } from '../src/services/remoteSync.js';
import { removeTempDir } from './helpers.js';

let tmp: string;
let services: AppServices;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

const isWin = process.platform === 'win32';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcc-remaining-'));
  services = createServices(path.join(tmp, 'test.sqlite'));
});

afterEach(async () => {
  services.db.close();
  await removeTempDir(tmp);
  delete process.env.DCC_SYNC_ENDPOINT;
  delete process.env.DCC_FAKE_KEY;
});

describe('GitHub CI check mapping (pure)', () => {
  it('maps check-run payloads honestly: no_checks / pending / failing / passing', () => {
    expect(GithubService.mapCheckRuns({})).toBe('no_checks');
    expect(GithubService.mapCheckRuns({ check_runs: [] })).toBe('no_checks');
    expect(GithubService.mapCheckRuns({ check_runs: [{ status: 'in_progress', conclusion: null }] })).toBe('pending');
    expect(GithubService.mapCheckRuns({
      check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }],
    })).toBe('failing');
    expect(GithubService.mapCheckRuns({
      check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'neutral' }, { status: 'completed', conclusion: 'skipped' }],
    })).toBe('passing');
    expect(GithubService.mapCheckRuns({
      check_runs: [{ status: 'completed', conclusion: 'timed_out' }],
    })).toBe('failing');
  });
});

describe('secret store', () => {
  it('round-trips values and never exposes them through status()', async () => {
    const store = new SecretStore();
    const set = await store.set('DCC_TEST_SECRET', 'value-should-never-appear');
    expect(set.ok).toBe(true);
    expect(await store.get('DCC_TEST_SECRET')).toBe('value-should-never-appear');
    expect(await store.resolveEnvRef('DCC_TEST_SECRET')).toBe('value-should-never-appear');
    const status = JSON.stringify(store.status());
    expect(status).not.toContain('value-should-never-appear');
    expect(status).toMatch(/env|windows_credential_manager/);
  });
});

describe('LLM client: outbound redaction + honest usage', () => {
  it('never sends raw secrets and reports usedLlm truthfully', async () => {
    const captured: string[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        captured.push(body);
        res.setHeader('content-type', 'application/json');
        // Ollama-style response with a code-fenced JSON payload.
        res.end(JSON.stringify({ response: '```json\n{"category":"bug","severity":"low","summary":"x"}\n```' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
      const secretValue = 'sk-abcdef0123456789012345678901234567890';
      process.env.DCC_FAKE_KEY = secretValue;
      const client = new LlmClient(
        { baseUrl: `http://127.0.0.1:${port}`, model: 'fake-model', apiKeyEnv: 'DCC_FAKE_KEY', style: 'ollama' },
        new SecretStore(),
        'local-model',
      );

      const result = await client.completeJson<{ category?: string }>(
        'system policy',
        `analyze this and never leak ${secretValue}`,
      );

      expect(result.ok).toBe(true);
      expect(result.usedLlm).toBe(true);
      expect('parsed' in result && result.parsed?.category).toBe('bug');
      expect(captured.length).toBe(1);
      expect(captured[0]).not.toContain(secretValue);
      expect(captured[0]).toContain('[REDACTED');
    } finally {
      server.close();
    }
  });

  it('fails honestly when no LLM is configured (usedLlm stays false)', async () => {
    const client = new LlmClient(
      { baseUrl: '', model: 'none', apiKeyEnv: '', style: 'ollama' },
      new SecretStore(),
      'local-model',
    );
    const result = await client.complete('s', 'u');
    expect(result.ok).toBe(false);
    expect(result.usedLlm).toBe(false);
  });
});

describe('agent adapters (fake CLI binaries)', () => {
  let binDir: string;
  let oldPath: string | undefined;

  const writeFake = (name: string, body: string) => {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, body);
    fs.chmodSync(file, 0o755);
  };

  beforeEach(() => {
    binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = oldPath;
  });

  it.runIf(!isWin)('claude-code adapter verifies, executes, and reports changed files', async () => {
    writeFake('claude', '#!/bin/bash\nif [ "$1" = "--version" ]; then echo "2.0.0-fake"; exit 0; fi\necho "work done" >> app.txt\necho \'{"ok":true}\'\nexit 0\n');

    const adapter = new ClaudeCodeAdapter();
    const check = await adapter.check();
    expect(check.status).toBe('verified');

    // Execute against a real git worktree.
    const repoPath = path.join(tmp, 'repo');
    fs.mkdirSync(repoPath);
    git(repoPath, 'init', '-b', 'main');
    git(repoPath, 'config', 'user.email', 't@e.com');
    git(repoPath, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repoPath, 'app.txt'), 'hello\n');
    git(repoPath, 'add', '.');
    git(repoPath, 'commit', '-m', 'init');

    const result = await adapter.execute({ worktreePath: repoPath, prompt: 'do work', budgetSeconds: 30 });
    expect(result.ok).toBe(true);
    expect(result.filesChanged).toContain('app.txt');
    expect(result.usedLlm).toBe(true);
  });

  it.runIf(!isWin)('codex adapter mirrors the same contract', async () => {
    writeFake('codex', '#!/bin/bash\nif [ "$1" = "--version" ]; then echo "0.1-fake"; exit 0; fi\necho "more" >> app.txt\nexit 0\n');
    const adapter = new CodexAdapter();
    expect((await adapter.check()).status).toBe('verified');
    const result = await adapter.execute({ worktreePath: tmp, prompt: 'p', budgetSeconds: 30 });
    expect(result.ok).toBe(true);
  });

  it('adapters report unavailable (never fake success) when binaries are missing', async () => {
    process.env.PATH = '/nonexistent-dir-for-test';
    const adapter = new ClaudeCodeAdapter();
    const check = await adapter.check();
    expect(check.status).toBe('unavailable');
  });

  it('http-api adapter is text-only and honest about LLM usage', async () => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url === '/v1/models') {
          res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'analysis only' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      const adapter = new HttpApiAdapter(new SecretStore(), () => ({
        baseUrl: `http://127.0.0.1:${port}`, model: 'fake-model', apiKeyEnv: '', style: 'openai' as const,
      }));
      expect((await adapter.check()).status).toBe('verified');
      expect(adapter.editsFiles).toBe(false);
      const result = await adapter.execute({ worktreePath: '', prompt: 'analyze', budgetSeconds: 30 });
      expect(result.ok).toBe(true);
      expect(result.usedLlm).toBe(true);
      expect(result.filesChanged).toEqual([]);
    } finally {
      server.close();
    }
  });
});

describe('remote sync (optional, explicit)', () => {
  it('push/pull round-trips bundles and discards tampered ones', async () => {
    let stored: Buffer | null = null;
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.end('{"status":"ok"}');
        return;
      }
      if (req.method === 'POST' && req.url === '/bundles') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          stored = Buffer.concat(chunks);
          res.end('{"ok":true}');
        });
        return;
      }
      if (req.method === 'GET' && req.url === '/bundles/latest') {
        if (!stored) { res.statusCode = 404; res.end('none'); return; }
        res.setHeader('content-type', 'application/octet-stream');
        res.end(stored);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    process.env.DCC_SYNC_ENDPOINT = `http://127.0.0.1:${port}`;

    try {
      const sync = new RemoteSyncService(new SecretStore(), services.audit, services.backup);

      expect((await sync.checkConnection()).status).toBe('verified');

      const push = await sync.push('tester');
      expect(push.ok).toBe(true);
      expect(push.bytes ?? 0).toBeGreaterThan(0);

      const pull = await sync.pull('tester');
      expect(pull.ok).toBe(true);
      expect(pull.file).toBeTruthy();
      // Restore is a gated external-ish action: the pull validates but does not install.
      expect(pull.note).toMatch(/validated|Restore/i);

      // Tamper with the stored bundle: pull must refuse it.
      stored = Buffer.from('this is definitely not a sqlite database');
      const bad = await sync.pull('tester');
      expect(bad.ok).toBe(false);
      expect(bad.note).toMatch(/validat|discard|corrupt/i);
    } finally {
      server.close();
      stored = null;
    }
  });

  it('is honestly disabled without configuration', async () => {
    const sync = new RemoteSyncService(new SecretStore(), services.audit, services.backup);
    const status = await sync.checkConnection();
    expect(status.status).toBe('disabled');
    expect((await sync.push('tester')).ok).toBe(false);
  });
});

describe('resolution sync-back', () => {
  it('records support resolution and reports unavailable channels honestly', async () => {
    const created = services.support.create({
      title: 'App crashes on startup',
      body: 'Detailed crash report',
      severity: 'high',
      channel: 'api',
    }, 'tester');
    const reportId = created.report.id;

    const resolved = services.support.recordResolution(reportId, { status: 'resolved', note: 'Fixed in build 42' }, 'tester');
    expect(resolved.ok).toBe(true);
    expect(services.support.get(reportId)?.status).toBe('resolved');

    // externalRef channel (Biza Miz live API) is not configured here: honest unavailability.
    services.db.run('UPDATE support_reports SET external_ref = ? WHERE id = ?', 'ext-123', reportId);
    const post = await services.ingest.postResolution('ext-123', { status: 'resolved', note: 'Fixed' }, 'tester');
    expect(post.ok).toBe(false);
    expect(post.note).toMatch(/not available|unavailable|unverified|UNKNOWN|unreachable|unconfigured|not configured/i);
  });
});

describe('autonomy >= 2 autonomous implementation', () => {
  it.runIf(!isWin)('runs implementation -> tests -> review -> PR prep, still approval-gated', async () => {
    // Fake coding agent on PATH.
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'claude'), '#!/bin/bash\nif [ "$1" = "--version" ]; then echo "2.0.0-fake"; exit 0; fi\necho "agent change" >> app.txt\necho done\nexit 0\n');
    fs.chmodSync(path.join(binDir, 'claude'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ''}`;

    try {
      // Real git repository registered as the work target.
      const repoPath = path.join(tmp, 'repo');
      fs.mkdirSync(repoPath);
      git(repoPath, 'init', '-b', 'main');
      git(repoPath, 'config', 'user.email', 't@e.com');
      git(repoPath, 'config', 'user.name', 'T');
      fs.writeFileSync(path.join(repoPath, 'app.txt'), 'hello\n');
      git(repoPath, 'add', '.');
      git(repoPath, 'commit', '-m', 'init');
      const reg = await services.registry.registerRepository({ localPath: repoPath, name: 'demo' }, 'tester');
      const repoId = reg.repo!.id;

      // Verify the coding adapter through the provider layer (binary probe).
      const claudeProvider = services.providers.getByKey('claude-code')!;
      const checked = await services.providers.check(claudeProvider.id, 'tester');
      expect(checked?.status).toBe('verified');

      const task = services.tasks.create({
        title: 'Fix startup crash',
        description: 'The app crashes on startup; add the fix.',
        repoId,
      }, 'tester');

      const result = await services.coordinator.runAutonomousImplementation(task.id, {
        providerId: checked!.id,
        repoId,
        actor: 'tester',
        budgetSeconds: 60,
      });

      expect(result.ok).toBe(true);
      const stages = Object.fromEntries(result.stages.map((s) => [s.stage, s]));
      expect(stages.implementation?.status).toBe('done');

      // The run record is the source of truth for implementation success.
      const run = services.runs.get(result.runId!);
      expect(run?.status).toBe('succeeded');
      const evidence = services.tasks.listEvidence(task.id);
      expect(evidence.length).toBeGreaterThan(0);

      // PR creation stays behind an approval gate — nothing external happened.
      const approvals = services.db.query<{ kind: string; status: string }>(
        `SELECT kind, status FROM approvals WHERE status = 'pending'`,
      );
      expect(approvals.some((a) => /github_write|external_write/.test(a.kind))).toBe(true);

      // Task advanced through the lifecycle but was never auto-merged/completed.
      const finalTask = services.tasks.get(task.id);
      expect(['Review', 'Ready for Merge']).toContain(finalTask?.internalStatus);
      expect(finalTask?.internalStatus).not.toBe('Completed');
    } finally {
      process.env.PATH = oldPath;
    }
  });

  it('records an honest skip (never success) when no coding agent is verified', async () => {
    const repoPath = path.join(tmp, 'repo');
    fs.mkdirSync(repoPath);
    git(repoPath, 'init', '-b', 'main');
    git(repoPath, 'config', 'user.email', 't@e.com');
    git(repoPath, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repoPath, 'app.txt'), 'hello\n');
    git(repoPath, 'add', '.');
    git(repoPath, 'commit', '-m', 'init');
    const reg = await services.registry.registerRepository({ localPath: repoPath, name: 'demo' }, 'tester');

    // Remove all agent binaries from PATH only after repo setup.
    const oldPath = process.env.PATH;
    process.env.PATH = '/nonexistent-dir-for-test';
    try {
      const task = services.tasks.create({ title: 'No agent available', repoId: reg.repo!.id }, 'tester');
      const result = await services.coordinator.runAutonomousImplementation(task.id, {
        providerId: null,
        repoId: reg.repo!.id,
        actor: 'tester',
        budgetSeconds: 30,
      });

      const stages = Object.fromEntries(result.stages.map((s) => [s.stage, s]));
      expect(stages.implementation?.status).toBe('skipped');
      expect(stages.implementation?.note).toMatch(/No verified coding agent/i);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe('task state walker honesty', () => {
  it('refuses backwards auto-advances and records the limitation', () => {
    const task = services.tasks.create({ title: 'walker' }, 'tester');
    expect(services.coordinator.advanceTask(task.id, 'Triage', 'tester', 'forward')).toBe(true);
    expect(services.tasks.get(task.id)?.internalStatus).toBe('Triage');

    expect(services.coordinator.advanceTask(task.id, 'Incoming', 'tester', 'backwards')).toBe(false);
    expect(services.tasks.get(task.id)?.internalStatus).toBe('Triage');

    const findings = services.coordinator.listFindings(task.id);
    expect(findings.some((f) => /Cannot auto-advance/.test(String(f.summary)))).toBe(true);
  });
});
