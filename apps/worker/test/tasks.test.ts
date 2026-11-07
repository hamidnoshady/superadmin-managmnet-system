import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServices, type AppServices } from '../src/services/seed.js';
import { removeTempDir } from './helpers.js';

let tmp: string;
let services: AppServices;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dcc-test-'));
  services = createServices(path.join(tmp, 'test.sqlite'));
});

afterEach(async () => {
  services.db.close();
  await removeTempDir(tmp);
});

describe('task lifecycle with evidence guard', () => {
  it('creates tasks with separated status tracks', () => {
    const task = services.tasks.create({ title: 'Test task', internalStatus: 'Incoming' }, 'tester');
    expect(task.internalStatus).toBe('Incoming');
    expect(task.githubStatus).toBe('unknown');
    expect(task.agentStatus).toBe('none');
    expect(task.testStatus).toBe('unknown');
    expect(task.prStatus).toBe('none');
  });

  it('walks the happy path and refuses completion without evidence', () => {
    const task = services.tasks.create({ title: 'Walk the path', acceptanceCriteria: ['Tests pass'] }, 'tester');
    let id = task.id;
    for (const to of ['Triage', 'Investigating', 'Planned', 'Waiting for Approval', 'Approved', 'In Development', 'Testing', 'Review', 'Ready for Merge'] as const) {
      const result = services.tasks.transition(id, to, 'tester');
      expect(result.ok, `transition to ${to}: ${result.error ?? ''}`).toBe(true);
      id = result.task!.id;
    }

    // No evidence yet -> completion denied (and the UI is told what IS allowed).
    const denied = services.tasks.transition(id, 'Completed', 'tester');
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/evidence/i);
    expect(denied.allowed).toContain('In Development');

    // Attach evidence -> completion allowed.
    services.tasks.addEvidence({ taskId: id, kind: 'test_output', summary: 'Tests pass: 42 passing', source: 'command' });
    const done = services.tasks.transition(id, 'Completed', 'tester');
    expect(done.ok).toBe(true);
    expect(done.task?.internalStatus).toBe('Completed');
  });

  it('records denied transitions in the audit trail', () => {
    const task = services.tasks.create({ title: 'Audit me' }, 'tester');
    services.tasks.transition(task.id, 'Completed', 'tester');
    const audit = services.audit.list();
    expect(audit.some((a) => a.action === 'task.transition' && a.outcome === 'denied')).toBe(true);
  });

  it('persists across "restarts" (new service instances on the same database)', () => {
    const task = services.tasks.create({ title: 'Persist me', internalStatus: 'In Development' }, 'tester');
    services.tasks.addEvidence({ taskId: task.id, kind: 'note', summary: 'work started' });

    // Simulate restart.
    const dbPath = services.db.filePath;
    services.db.close();
    services = createServices(dbPath);

    const reloaded = services.tasks.get(task.id);
    expect(reloaded?.title).toBe('Persist me');
    expect(reloaded?.internalStatus).toBe('In Development');
    expect(services.tasks.listEvidence(task.id)).toHaveLength(1);
  });

  it('keeps external tracks independent of internal state', () => {
    const task = services.tasks.create({ title: 'Tracks' }, 'tester');
    services.tasks.setExternalStatus(task.id, 'github', 'open', 'tester');
    services.tasks.setExternalStatus(task.id, 'test', 'failing', 'tester');
    const updated = services.tasks.get(task.id);
    expect(updated?.internalStatus).toBe('Incoming'); // untouched
    expect(updated?.githubStatus).toBe('open');
    expect(updated?.testStatus).toBe('failing');
  });
});

describe('support intake (Biza Miz)', () => {
  it('redacts secrets on intake and never stores raw tenant refs', () => {
    const { report, findings } = services.support.create({
      title: 'Installer crash',
      body: 'Token ghp_abcdefghijklmnopqrstuvwxyz123456 in log. Tenant ref TEN-1. Contact a@b.com.',
      tenantRef: 'TEN-1',
    }, 'tester');

    expect(report.bodyRedacted).not.toContain('ghp_');
    expect(report.bodyRedacted).toContain('[REDACTED:GITHUB_TOKEN]');
    expect(findings.length).toBeGreaterThan(0);
    expect(report.tenantRefHash).toBeTruthy();
    expect(report.tenantRefHash).not.toContain('TEN-1');
  });

  it('triages installation problems into the right category', () => {
    const { report } = services.support.create({
      title: 'Installation fails during update',
      body: 'The update installer fails with 0x80070005.',
    }, 'tester');
    const result = services.support.triage(report.id, 'tester');
    expect('result' in result && result.result.category).toBe('installation/update');
  });

  it('produces advisory duplicate candidates without discarding reports', () => {
    const a = services.support.create({ title: 'Installation fails during update on Windows 11', body: 'installer error 0x80070005 update package' }, 'tester').report;
    services.support.create({ title: 'Installation fails during update on Windows 11', body: 'installer error 0x80070005 applying update' }, 'tester');
    const candidates = services.support.findDuplicates(a.id);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].score).toBeGreaterThanOrEqual(0.5);
    // The original reports still exist untouched.
    expect(services.support.list()).toHaveLength(2);
  });

  it('builds issue drafts from redacted content only', () => {
    const { report } = services.support.create({
      title: 'Crash on launch',
      body: 'App crashes. Secret sk-abcdef123456789012345678901234567890 must not leak.',
    }, 'tester');
    const draft = services.support.buildIssueDraft(report.id);
    expect('body' in draft).toBe(true);
    if ('body' in draft) {
      expect(draft.body).not.toContain('sk-abcdef');
      expect(draft.body).toContain('[REDACTED:API_KEY]');
    }
  });
});

describe('approval gates', () => {
  it('blocks issue creation until approved', () => {
    const req = services.approvals.request({ kind: 'issue_create', title: 'Create issue X', payload: {}, requestedBy: 'tester' });
    expect(services.approvals.checkGate('issue_create', req.id).ok).toBe(false);

    services.approvals.decide(req.id, 'approved', 'owner', 'looks good');
    expect(services.approvals.checkGate('issue_create', req.id).ok).toBe(true);
  });

  it('treats rejected approvals as denied', () => {
    const req = services.approvals.request({ kind: 'merge', title: 'Merge PR 7', payload: {}, requestedBy: 'tester' });
    services.approvals.decide(req.id, 'rejected', 'owner', 'not yet');
    const gate = services.approvals.checkGate('merge', req.id);
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toMatch(/rejected/);
  });

  it('requires approval even when no request exists', () => {
    const gate = services.approvals.checkGate('deploy', null);
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.requiresApproval).toBe(true);
  });
});
