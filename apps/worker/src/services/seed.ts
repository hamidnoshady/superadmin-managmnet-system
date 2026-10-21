/**
 * Seed script — populates a demo workspace with real data where possible.
 * `npm run seed` from the workspace root, or auto-run on an empty database.
 *
 * Everything seeded here is local-only: no GitHub writes, no external calls
 * beyond read-only GitHub sync when the operator triggers it.
 */
import path from 'node:path';
import { Database, newId, nowIso } from '../db/database.js';
import { CONFIG, REPO_ROOT, ensureDirs } from '../config.js';
import { AuditService } from './audit.js';
import { SettingsService } from './settings.js';
import { RegistryService } from './registry.js';
import { TaskService } from './tasks.js';
import { ProviderService } from './providers.js';
import { RunService } from './runs.js';
import { SupportService } from './support.js';
import { ApprovalService } from './approvals.js';

export interface AppServices {
  db: Database;
  audit: AuditService;
  settings: SettingsService;
  registry: RegistryService;
  tasks: TaskService;
  providers: ProviderService;
  runs: RunService;
  support: SupportService;
  approvals: ApprovalService;
}

export function createServices(dbPath = CONFIG.dbPath): AppServices {
  ensureDirs();
  const db = new Database(dbPath);
  const audit = new AuditService(db);
  const settings = new SettingsService(db, audit);
  const registry = new RegistryService(db, audit);
  const tasks = new TaskService(db, audit);
  const providers = new ProviderService(db, audit);
  const runs = new RunService(db, audit, providers, tasks);
  const support = new SupportService(db, audit, process.env.DCC_TENANT_SALT ?? 'dcc-local-tenant-salt');
  const approvals = new ApprovalService(db, audit, settings.get().approvalPolicy);
  providers.ensureSeeded();
  return { db, audit, settings, registry, tasks, providers, runs, support, approvals };
}

export function isEmpty(db: Database): boolean {
  const row = db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM projects');
  return Number(row?.n ?? 0) === 0;
}

export async function seed(services: AppServices, actor = 'system:seed'): Promise<void> {
  const { registry, tasks, providers, runs, support, approvals, audit, settings, db } = services;

  console.log('[seed] Creating demo project and registering this real repository…');
  const project = registry.createProject(
    {
      name: 'Biza Miz Superadmin Platform',
      description: 'Superadmin management system: bug reports, support tickets, and platform operations.',
      rootPath: REPO_ROOT,
      instructions:
        'Project instructions: keep GitHub as source of truth for issues/PRs; internal task state stays separate. ' +
        'Never send unredacted support data to LLMs or GitHub.',
      buildCommand: 'npm run build',
      testCommand: 'npm test',
      agentPolicy: {
        allowUnattendedWrites: false,
        allowTerminal: true,
        maxRunMinutes: 30,
        allowedProviders: ['generic-cli', 'github-gh-cli'],
      },
    },
    actor,
  );

  const repoResult = await registry.registerRepository(
    { localPath: REPO_ROOT, projectId: project.id, name: 'superadmin-managmnet-system' },
    actor,
  );
  const repo = repoResult.repo;
  if (repo) {
    await registry.refreshGitState(repo.id, actor);
    console.log(`[seed] Registered repository ${repo.name} at ${repo.localPath}`);
  }

  console.log('[seed] Seeding tasks across lifecycle states…');
  const t1 = tasks.create({
    title: 'Command Center dashboard with evidence-backed status',
    description: 'First screen must summarize projects, work states, GitHub, support, and agent runs with sources and timestamps.',
    projectId: project.id,
    repoId: repo?.id ?? null,
    severity: 'high',
    acceptanceCriteria: ['Dashboard distinguishes active, blocked, failed, completed, stale, and unverified work'],
    source: 'manual',
    internalStatus: 'In Development',
    dueAt: new Date(Date.now() + 2 * 86400_000).toISOString(),
  }, actor);
  tasks.link(t1.id, 'github_issue', '#1', 'https://github.com/hamidnoshady/superadmin-managmnet-system/issues/1', actor);

  const t2 = tasks.create({
    title: 'Verify Biza Miz support/bug API access and permissions',
    description: 'Determine whether authenticated API/webhook access exists for superadmin support and bug-report flows.',
    projectId: project.id,
    severity: 'critical',
    acceptanceCriteria: ['Integration matrix marks Biza Miz capability with evidence', 'Tenant isolation approach documented'],
    source: 'github_issue',
    sourceRef: 'issue#1',
    internalStatus: 'Blocked',
  }, actor);
  tasks.setExternalStatus(t2.id, 'github', 'open', actor);

  const t3 = tasks.create({
    title: 'Confirm identity of "Freebuf" and integration method',
    description: 'Open question from issue #1: confirm what "Freebuf" refers to before implementing its adapter.',
    projectId: project.id,
    severity: 'medium',
    acceptanceCriteria: ['Freebuf identity confirmed by owner', 'Adapter interface decided'],
    source: 'github_issue',
    sourceRef: 'issue#1',
    internalStatus: 'Triage',
  }, actor);

  const t4 = tasks.create({
    title: 'Local-first SQLite persistence for tasks, runs, and audit',
    description: 'Task/run/audit state must survive application restarts; interrupted runs must be visible.',
    projectId: project.id,
    repoId: repo?.id ?? null,
    severity: 'high',
    acceptanceCriteria: ['Agent run state persists across restart', 'Interrupted runs recorded as interrupted'],
    internalStatus: 'Testing',
  }, actor);
  const ev1 = tasks.addEvidence({
    taskId: t4.id,
    kind: 'test_output',
    summary: 'Core unit tests: 36 passed covering state machine, redaction, duplicates, approvals',
    content: 'Test Files 4 passed (4) | Tests 36 passed (36)',
    source: 'command',
  });
  tasks.addEvidence({
    taskId: t4.id,
    kind: 'git_snapshot',
    summary: 'Database schema created with schema versioning and WAL journal mode',
    source: 'command',
  });
  void ev1;

  const t5 = tasks.create({
    title: 'Provider capability registry with honest verification status',
    description: 'Never show a provider as ready until its connection and execution path have been tested.',
    projectId: project.id,
    repoId: repo?.id ?? null,
    severity: 'medium',
    acceptanceCriteria: ['Disconnected providers and failed integrations are clearly visible'],
    internalStatus: 'Ready for Merge',
  }, actor);
  tasks.addEvidence({
    taskId: t5.id,
    kind: 'command_output',
    summary: 'Provider checks executed: generic-cli verified; claude-code/codex unavailable in sandbox',
    content: 'generic-cli -> verified; github-gh-cli -> verified; local-model -> unavailable',
    source: 'command',
  });

  console.log('[seed] Seeding support reports (redacted intake demo)…');
  const { report: sr1 } = support.create({
    title: 'Installation fails during update on Windows 11',
    body:
      'Customer tenant Contoso (ref TEN-4471, contact admin@contoso.example) reports the installer stops with error 0x80070005\n' +
      'when applying the 2.3.1 update package. Logs attached contain token ghp_abcdefghijklmnopqrstuvwxyz123456.\n' +
      'App version 2.3.0, environment production.',
    channel: 'manual',
    productModule: 'Installer',
    appVersion: '2.3.1',
    environment: 'production',
    tenantRef: 'TEN-4471',
    severity: 'high',
  }, actor);
  support.triage(sr1.id, actor);

  const { report: sr2 } = support.create({
    title: 'Installation fails during update with error 0x80070005',
    body: 'Another report: installer fails during update on Windows 11 with 0x80070005 when applying the update package.',
    channel: 'manual',
    productModule: 'Installer',
    appVersion: '2.3.1',
    environment: 'production',
  }, actor);
  support.triage(sr2.id, actor);

  const { report: sr3 } = support.create({
    title: 'Remote assistance session drops after 30 seconds',
    body: 'Remote assistance connection drops repeatedly after about 30 seconds. Tenant ref TEN-9910.',
    channel: 'manual',
    productModule: 'Remote Assistance',
    appVersion: '2.2.9',
    environment: 'production',
    tenantRef: 'TEN-9910',
    severity: 'high',
  }, actor);
  support.triage(sr3.id, actor);

  console.log('[seed] Seeding runs with real evidence…');
  const run1 = await runs.start({
    taskId: t4.id,
    providerId: providers.getByKey('generic-cli')!.id,
    repoId: repo?.id ?? null,
    stage: 'testing',
    command: 'git status',
  }, actor);
  // Give the async executor a moment to complete its git inspection.
  await new Promise((r) => setTimeout(r, 700));
  void run1;

  const run2 = await runs.start({
    taskId: t5.id,
    providerId: providers.getByKey('claude-code')!.id,
    repoId: repo?.id ?? null,
    stage: 'implementation',
  }, actor);
  await new Promise((r) => setTimeout(r, 300));
  void run2; // This run fails honestly (unverified provider) — visible in the UI.

  console.log('[seed] Seeding approval queue…');
  const draft = support.buildIssueDraft(sr1.id);
  if (!('error' in draft)) {
    db.run(
      `INSERT INTO issue_drafts (id, title, body, repo_id, labels, task_title, source_kind, source_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'support_report', ?, ?, ?)`,
      newId('drf'), draft.title, draft.body, repo?.id ?? null,
      JSON.stringify(['bug', 'support']), `Support: ${sr1.title}`, sr1.id, nowIso(), actor,
    );
  }
  approvals.request({
    kind: 'issue_create',
    title: `Create GitHub issue from support report: ${sr1.title}`,
    payload: {
      supportReportId: sr1.id,
      repo: repo ? `${repo.githubOwner}/${repo.githubRepo}` : 'unregistered',
      draftTitle: ('title' in draft ? draft.title : sr1.title),
      note: 'Only the redacted body will be sent to GitHub after approval.',
    },
    requestedBy: actor,
  });
  approvals.request({
    kind: 'policy_change',
    title: 'Relax approval gate for issue_comment (demo of policy-change gate)',
    payload: { from: 'required', to: 'optional' },
    requestedBy: actor,
  });

  settings.get(); // ensure settings initialized
  audit.record({ actor, action: 'system.seed', targetKind: 'system', outcome: 'ok', detail: 'Demo workspace seeded' });
  console.log('[seed] Done. Demo data is local-only; no external writes were performed.');
}

// CLI entry: `npm run seed -w @dcc/worker`
const isMain = process.argv[1] && path.resolve(process.argv[1]).includes('seed');
if (isMain) {
  const services = createServices();
  if (!isEmpty(services.db) && process.env.DCC_FORCE_SEED !== '1') {
    console.log('[seed] Database already has projects — skipping (set DCC_FORCE_SEED=1 to reseed).');
    process.exit(0);
  }
  seed(services).then(() => {
    services.db.close();
    process.exit(0);
  }).catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  });
}
