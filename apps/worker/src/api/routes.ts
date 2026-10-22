import { Router, type Request, type Response } from 'express';
import type { ApprovalKind, TaskStatus } from '@dcc/core';
import type { AppServices } from '../services/seed.js';
import { GithubService } from '../services/github.js';
import { DashboardService } from '../services/dashboard.js';
import { seed, isEmpty } from '../services/seed.js';

export function buildRoutes(services: AppServices): Router {
  const router = Router();
  const github = new GithubService(services.db, services.audit);
  const dashboard = new DashboardService(services.db, services.settings);

  const actorOf = (req: Request): string => {
    const header = req.header('x-actor');
    return header && header.trim() ? header.trim() : 'user';
  };

  const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      services.audit.record({
        actor: actorOf(req), action: `api:${req.method} ${req.path}`, targetKind: 'api',
        outcome: 'error', detail: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    });
  };

  // ---- Health & dashboard ---------------------------------------------------

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      name: 'dev-command-center-worker',
      version: '0.1.0',
      time: new Date().toISOString(),
      persistence: 'sqlite (local, survives restart)',
    });
  });

  router.get('/dashboard', wrap((_req, res) => {
    res.json(dashboard.summary());
  }));

  router.get('/dashboard/stale', wrap((_req, res) => {
    res.json(dashboard.staleWorkItems());
  }));

  router.get('/search', wrap((req, res) => {
    const q = String(req.query.q ?? '');
    res.json(dashboard.search(q));
  }));

  // ---- Settings & audit ------------------------------------------------------

  router.get('/settings', wrap((_req, res) => res.json(services.settings.get())));

  router.put('/settings', wrap((req, res) => {
    const actor = actorOf(req);
    const current = services.settings.get();
    const next = { ...current, ...req.body };
    const gate = services.settings.canChangePolicy(current.approvalPolicy, next.approvalPolicy ?? current.approvalPolicy, req.header('x-policy-approved') === '1');
    if (!gate.ok) {
      services.audit.record({ actor, action: 'settings.update', targetKind: 'settings', outcome: 'denied', detail: gate.reason ?? null });
      res.status(403).json({ error: gate.reason, requiresApproval: true });
      return;
    }
    services.approvals.setPolicy(next.approvalPolicy);
    res.json(services.settings.save(next, actor));
  }));

  router.get('/audit', wrap((_req, res) => res.json(services.audit.list(300))));

  // ---- Projects ---------------------------------------------------------------

  router.get('/projects', wrap((_req, res) => res.json(services.registry.listProjects())));

  router.post('/projects', wrap((req, res) => {
    const project = services.registry.createProject(req.body ?? {}, actorOf(req));
    res.status(201).json(project);
  }));

  router.patch('/projects/:id', wrap((req, res) => {
    const updated = services.registry.updateProject(req.params.id, req.body ?? {}, actorOf(req));
    if (!updated) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json(updated);
  }));

  // ---- Repositories ------------------------------------------------------------

  router.get('/repositories', wrap((_req, res) => res.json(services.registry.listRepositories())));

  router.post('/repositories', wrap(async (req, res) => {
    const result = await services.registry.registerRepository(
      { localPath: String(req.body?.localPath ?? ''), projectId: req.body?.projectId ?? null, name: req.body?.name },
      actorOf(req),
    );
    res.status(result.ok ? 201 : 400).json(result);
  }));

  router.post('/repositories/:id/refresh', wrap(async (req, res) => {
    const result = await services.registry.refreshGitState(req.params.id, actorOf(req));
    res.status(result.ok ? 200 : 400).json(result);
  }));

  router.get('/repositories/:id', wrap((req, res) => {
    const repo = services.registry.getRepository(req.params.id);
    if (!repo) { res.status(404).json({ error: 'Repository not found' }); return; }
    res.json(repo);
  }));

  router.post('/scan', wrap((req, res) => {
    const roots: string[] = Array.isArray(req.body?.roots) ? req.body.roots : services.settings.get().scanRoots;
    res.json(services.registry.scanRoots(roots, Number(req.body?.maxDepth ?? 3)));
  }));

  // ---- Tasks ---------------------------------------------------------------------

  router.get('/tasks', wrap((req, res) => {
    res.json(services.tasks.list({
      status: req.query.status ? (String(req.query.status) as TaskStatus) : undefined,
      projectId: req.query.projectId ? String(req.query.projectId) : undefined,
      repoId: req.query.repoId ? String(req.query.repoId) : undefined,
    }));
  }));

  router.post('/tasks', wrap((req, res) => {
    res.status(201).json(services.tasks.create(req.body ?? {}, actorOf(req)));
  }));

  router.get('/tasks/:id', wrap((req, res) => {
    const task = services.tasks.get(req.params.id);
    if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
    res.json({
      task,
      evidence: services.tasks.listEvidence(task.id),
      links: services.tasks.listLinks(task.id),
      criteriaCoverage: services.tasks.criteriaCoverage(task.id),
    });
  }));

  router.patch('/tasks/:id', wrap((req, res) => {
    const updated = services.tasks.update(req.params.id, req.body ?? {}, actorOf(req));
    if (!updated) { res.status(404).json({ error: 'Task not found' }); return; }
    res.json(updated);
  }));

  router.post('/tasks/:id/transition', wrap((req, res) => {
    const result = services.tasks.transition(req.params.id, String(req.body?.to ?? '') as TaskStatus, actorOf(req), req.body?.reason);
    res.status(result.ok ? 200 : 400).json(result);
  }));

  router.post('/tasks/:id/external-status', wrap((req, res) => {
    const track = String(req.body?.track ?? '') as 'github' | 'agent' | 'test' | 'pr' | 'deploy';
    const value = String(req.body?.value ?? '') as never;
    const updated = services.tasks.setExternalStatus(req.params.id, track, value, actorOf(req));
    if (!updated) { res.status(404).json({ error: 'Task not found' }); return; }
    res.json(updated);
  }));

  router.post('/tasks/:id/evidence', wrap((req, res) => {
    const evidence = services.tasks.addEvidence({
      taskId: req.params.id,
      kind: req.body?.kind ?? 'note',
      summary: String(req.body?.summary ?? ''),
      content: req.body?.content ?? null,
      ref: req.body?.ref ?? null,
      source: req.body?.source ?? 'manual',
    });
    res.status(201).json(evidence);
  }));

  router.post('/tasks/:id/links', wrap((req, res) => {
    services.tasks.link(req.params.id, String(req.body?.kind ?? 'link'), String(req.body?.ref ?? ''), req.body?.url ?? null, actorOf(req));
    res.status(201).json({ ok: true });
  }));

  // ---- GitHub ----------------------------------------------------------------------

  router.get('/github/auth', wrap(async (_req, res) => {
    res.json(await github.checkAuth());
  }));

  router.post('/github/sync', wrap(async (req, res) => {
    const repo = services.registry.getRepository(String(req.body?.repoId ?? ''));
    if (!repo) { res.status(404).json({ error: 'Repository not found' }); return; }
    res.json(await github.syncRepo(repo));
  }));

  router.get('/github/issues', wrap((req, res) => {
    res.json(github.listIssues(String(req.query.repoId ?? '')));
  }));

  router.get('/github/pulls', wrap((req, res) => {
    res.json(github.listPullRequests(String(req.query.repoId ?? '')));
  }));

  router.get('/issue-drafts', wrap((_req, res) => {
    res.json(services.db.query('SELECT * FROM issue_drafts ORDER BY created_at DESC'));
  }));

  router.post('/issue-drafts', wrap((req, res) => {
    const title = String(req.body?.title ?? 'Untitled draft');
    const body = String(req.body?.body ?? '');
    const id = `drf_${Date.now().toString(36)}`;
    services.db.run(
      `INSERT INTO issue_drafts (id, title, body, repo_id, labels, task_title, source_kind, source_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, title, body, req.body?.repoId ?? null,
      JSON.stringify(req.body?.labels ?? []), String(req.body?.taskTitle ?? ''),
      String(req.body?.sourceKind ?? 'manual'), req.body?.sourceId ?? null,
      new Date().toISOString(), actorOf(req),
    );
    // Creating an external GitHub issue from the draft requires approval.
    const approval = services.approvals.request({
      kind: 'issue_create',
      title: `Create GitHub issue: ${title.slice(0, 80)}`,
      payload: { draftId: id, repoId: req.body?.repoId ?? null },
      requestedBy: actorOf(req),
    });
    res.status(201).json({ draftId: id, approval });
  }));

  /**
   * Execute an approved GitHub issue creation. Re-checks the approval gate at
   * execution time; content is redacted before leaving the machine.
   */
  router.post('/github/create-issue', wrap(async (req, res) => {
    const actor = actorOf(req);
    const gate = services.approvals.checkGate('issue_create', req.body?.approvalId ?? null);
    if (!gate.ok) {
      services.audit.record({ actor, action: 'github.issue_create', targetKind: 'api', outcome: 'denied', detail: gate.reason ?? null });
      res.status(403).json({ error: gate.reason, requiresApproval: true });
      return;
    }
    const repo = services.registry.getRepository(String(req.body?.repoId ?? ''));
    if (!repo) { res.status(404).json({ error: 'Repository not found' }); return; }
    const result = await github.createIssue(repo, String(req.body?.title ?? ''), String(req.body?.body ?? ''), req.body?.labels ?? [], actor);
    res.status(result.ok ? 201 : 400).json(result);
  }));

  // ---- Support (Biza Miz) ------------------------------------------------------------

  router.get('/support/reports', wrap((_req, res) => res.json(services.support.list())));

  router.post('/support/reports', wrap((req, res) => {
    const { report, findings } = services.support.create(req.body ?? {}, actorOf(req));
    res.status(201).json({ report, redactionFindings: findings });
  }));

  router.get('/support/reports/:id', wrap((req, res) => {
    const report = services.support.get(req.params.id);
    if (!report) { res.status(404).json({ error: 'Report not found' }); return; }
    res.json(report);
  }));

  router.post('/support/reports/:id/triage', wrap((req, res) => {
    const result = services.support.triage(req.params.id, actorOf(req));
    if ('error' in result) { res.status(404).json(result); return; }
    res.json(result);
  }));

  router.get('/support/reports/:id/duplicates', wrap((req, res) => {
    res.json(services.support.findDuplicates(req.params.id));
  }));

  router.post('/support/reports/:id/duplicate', wrap((req, res) => {
    services.support.recordDuplicate(req.params.id, req.body?.duplicateOfId ?? null, req.body?.score ?? null, actorOf(req));
    res.json({ ok: true });
  }));

  router.post('/support/reports/:id/link-task', wrap((req, res) => {
    services.support.linkTask(req.params.id, String(req.body?.taskId ?? ''), actorOf(req));
    res.json({ ok: true });
  }));

  router.post('/support/reports/:id/issue-draft', wrap((req, res) => {
    const draft = services.support.buildIssueDraft(req.params.id);
    if ('error' in draft) { res.status(400).json(draft); return; }
    const id = `drf_${Date.now().toString(36)}`;
    services.db.run(
      `INSERT INTO issue_drafts (id, title, body, repo_id, labels, task_title, source_kind, source_id, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'support_report', ?, ?, ?)`,
      id, draft.title, draft.body, req.body?.repoId ?? null,
      JSON.stringify(['bug', 'support']), draft.title, req.params.id,
      new Date().toISOString(), actorOf(req),
    );
    const approval = services.approvals.request({
      kind: 'issue_create',
      title: `Create GitHub issue from support report (${req.params.id})`,
      payload: { draftId: id, supportReportId: req.params.id, repoId: req.body?.repoId ?? null },
      requestedBy: actorOf(req),
    });
    res.status(201).json({ draftId: id, title: draft.title, body: draft.body, approval });
  }));

  // ---- Providers -----------------------------------------------------------------------

  router.get('/providers', wrap((_req, res) => res.json(services.providers.list())));

  router.post('/providers/:id/check', wrap(async (req, res) => {
    const provider = await services.providers.check(req.params.id, actorOf(req));
    if (!provider) { res.status(404).json({ error: 'Provider not found' }); return; }
    res.json(provider);
  }));

  router.post('/providers/:id/enable', wrap((req, res) => {
    services.providers.setEnabled(req.params.id, Boolean(req.body?.enabled ?? true), actorOf(req));
    res.json(services.providers.get(req.params.id) ?? { error: 'Provider not found' });
  }));

  // ---- Runs ---------------------------------------------------------------------------------

  router.get('/runs', wrap((req, res) => {
    res.json(services.runs.list(Number(req.query.limit ?? 100)));
  }));

  router.get('/runs/:id', wrap((req, res) => {
    const run = services.runs.get(req.params.id);
    if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
    res.json({ run, events: services.runs.listEvents(run.id) });
  }));

  router.post('/runs', wrap(async (req, res) => {
    const result = await services.runs.start({
      taskId: req.body?.taskId ?? null,
      providerId: String(req.body?.providerId ?? ''),
      repoId: req.body?.repoId ?? null,
      stage: req.body?.stage,
      budgetSeconds: req.body?.budgetSeconds,
      command: req.body?.command,
    }, actorOf(req));
    res.status(result.ok ? 201 : 400).json(result);
  }));

  router.post('/runs/:id/cancel', wrap(async (req, res) => {
    const result = await services.runs.cancel(req.params.id, actorOf(req));
    res.status(result.ok ? 200 : 400).json(result);
  }));

  // ---- Approvals --------------------------------------------------------------------------

  router.get('/approvals', wrap((req, res) => {
    const status = req.query.status ? (String(req.query.status) as 'pending' | 'approved' | 'rejected' | 'expired') : undefined;
    res.json(services.approvals.list(status));
  }));

  router.post('/approvals', wrap((req, res) => {
    const approval = services.approvals.request({
      kind: String(req.body?.kind ?? 'external_write') as ApprovalKind,
      title: String(req.body?.title ?? 'Approval requested'),
      payload: req.body?.payload ?? {},
      requestedBy: actorOf(req),
    });
    res.status(201).json(approval);
  }));

  router.post('/approvals/:id/decide', wrap((req, res) => {
    const decision = req.body?.decision === 'approved' ? 'approved' : 'rejected';
    const result = services.approvals.decide(req.params.id, decision, actorOf(req), req.body?.reason);
    res.status(result.ok ? 200 : 400).json(result);
  }));

  // ---- Coordinator (Phase 3) ------------------------------------------------------

  router.get('/coordinator/recommend/:taskId', wrap((req, res) => {
    res.json(services.coordinator.recommend(req.params.taskId));
  }));

  router.post('/coordinator/assign', wrap((req, res) => {
    const result = services.coordinator.assign({
      taskId: String(req.body?.taskId ?? ''),
      providerId: req.body?.providerId ?? null,
      repoId: req.body?.repoId ?? null,
      budgetSeconds: req.body?.budgetSeconds,
      maxAttempts: req.body?.maxAttempts,
      acceptanceCriteria: req.body?.acceptanceCriteria,
    }, actorOf(req));
    res.status(result.ok ? 200 : 400).json(result);
  }));

  router.post('/coordinator/start', wrap(async (req, res) => {
    const result = await services.coordinator.startGuardedRun({
      taskId: req.body?.taskId ?? null,
      providerId: String(req.body?.providerId ?? ''),
      repoId: req.body?.repoId ?? null,
      stage: req.body?.stage,
      budgetSeconds: req.body?.budgetSeconds,
      maxAttempts: req.body?.maxAttempts,
      files: req.body?.files,
    }, actorOf(req));
    res.status(result.ok ? 201 : 400).json(result);
  }));

  router.post('/coordinator/runs/:id/tests', wrap(async (req, res) => {
    const result = await services.coordinator.runTests(req.params.id, req.body?.command);
    res.json(result);
  }));

  router.post('/coordinator/runs/:id/review', wrap(async (req, res) => {
    const result = await services.coordinator.review(req.params.id);
    res.json(result);
  }));

  router.post('/coordinator/runs/:id/pr', wrap((req, res) => {
    const result = services.coordinator.preparePr(req.params.id);
    res.status(result.ok ? 201 : 400).json(result);
  }));

  router.get('/coordinator/preparations', wrap((_req, res) => {
    res.json(services.coordinator.listPreparations());
  }));

  router.post('/runs/:id/retry', wrap(async (req, res) => {
    services.runs.enforceTimeouts();
    const retry = await services.runs.retry(req.params.id, actorOf(req));
    res.status(retry.ok ? 201 : 400).json(retry);
  }));

  /**
   * Execute an approved PR creation. Re-checks the approval gate at execution time.
   */
  router.post('/github/create-pr', wrap(async (req, res) => {
    const actor = actorOf(req);
    const gate = services.approvals.checkGate('github_write', req.body?.approvalId ?? null);
    if (!gate.ok) {
      services.audit.record({ actor, action: 'github.pr_create', targetKind: 'api', outcome: 'denied', detail: gate.reason ?? null });
      res.status(403).json({ error: gate.reason, requiresApproval: true });
      return;
    }
    const repo = services.registry.getRepository(String(req.body?.repoId ?? ''));
    if (!repo) { res.status(404).json({ error: 'Repository not found' }); return; }
    const result = await github.createPullRequest(
      repo,
      String(req.body?.title ?? ''),
      String(req.body?.body ?? ''),
      String(req.body?.head ?? ''),
      String(req.body?.base ?? repo.defaultBranch ?? 'main'),
      actor,
    );
    res.status(result.ok ? 201 : 400).json(result);
  }));

  // ---- AI Brain pipeline (Phase 2/3) ------------------------------------------

  router.post('/brain/pipeline', wrap(async (req, res) => {
    const result = await services.brain.runPipeline(String(req.body?.taskId ?? ''), {
      providerId: req.body?.providerId ?? null,
      repoId: req.body?.repoId ?? null,
      autonomyLevel: req.body?.autonomyLevel,
      actor: actorOf(req),
    });
    res.status(result.ok ? 201 : 400).json(result);
  }));

  router.get('/tasks/:id/findings', wrap((req, res) => {
    res.json(services.coordinator.listFindings(req.params.id));
  }));

  router.post('/tasks/:id/dependencies', wrap((req, res) => {
    const result = services.tasks.addDependency(req.params.id, String(req.body?.dependsOnTaskId ?? ''), actorOf(req), req.body?.kind);
    res.status(result.ok ? 201 : 400).json(result);
  }));

  router.get('/tasks/:id/dependencies', wrap((req, res) => {
    res.json({
      dependencies: services.tasks.listDependencies(req.params.id),
      unmet: services.tasks.unmetDependencies(req.params.id),
    });
  }));

  // ---- Biza Miz ingestion (Phase 2) ---------------------------------------------

  router.get('/ingest/biza-miz', wrap((_req, res) => res.json(services.ingest.getConfig())));

  router.put('/ingest/biza-miz', wrap((req, res) => {
    res.json(services.ingest.saveConfig(req.body ?? {}, actorOf(req)));
  }));

  router.get('/ingest/check', wrap(async (_req, res) => {
    res.json(await services.ingest.checkConnection());
  }));

  router.post('/ingest/api', wrap(async (req, res) => {
    res.json(await services.ingest.ingestFromApi(actorOf(req)));
  }));

  router.post('/ingest/webhook', wrap((req, res) => {
    res.json(services.ingest.ingestFromWebhook(req.headers as Record<string, string | undefined>, req.body ?? {}, actorOf(req)));
  }));

  router.post('/ingest/import', wrap((req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    res.json(services.ingest.importBatch(items, 'import', String(req.body?.source ?? 'manual-import'), actorOf(req)));
  }));

  router.get('/ingest/batches', wrap((_req, res) => res.json(services.ingest.listBatches())));

  // ---- Engineering health & release readiness (Phase 4) -------------------------

  router.get('/engineering/health', wrap((_req, res) => {
    res.json(services.health.compute());
  }));

  // ---- Backup / restore / workspace bundle (Phase 4) ----------------------------

  router.get('/backups', wrap((_req, res) => res.json(services.backup.list())));

  router.post('/backups/export', wrap(async (req, res) => {
    res.json(await services.backup.exportBundle(actorOf(req)));
  }));

  router.post('/backups/validate', wrap((req, res) => {
    res.json(services.backup.validate(String(req.body?.file ?? '')));
  }));

  router.post('/backups/restore', wrap((req, res) => {
    const actor = actorOf(req);
    const gate = services.approvals.checkGate('restore_backup', req.body?.approvalId ?? null);
    if (!gate.ok) {
      services.audit.record({ actor, action: 'backup.restore', targetKind: 'api', outcome: 'denied', detail: gate.reason ?? null });
      res.status(403).json({ error: gate.reason, requiresApproval: true });
      return;
    }
    res.json(services.backup.restore(String(req.body?.file ?? ''), actor));
  }));

  // ---- Open repository (IDE / terminal) ------------------------------------------

  router.post('/repositories/:id/open', wrap(async (req, res) => {
    const actor = actorOf(req);
    const repo = services.registry.getRepository(req.params.id);
    if (!repo) { res.status(404).json({ error: 'Repository not found' }); return; }
    const target = req.body?.target === 'terminal' ? 'terminal' : 'ide';

    // A shell is a consequential execution surface — terminal launches are approval-gated.
    if (target === 'terminal') {
      const gate = services.approvals.checkGate('external_write', req.body?.approvalId ?? null);
      if (!gate.ok) {
        services.audit.record({ actor, action: 'repo.open_terminal', targetKind: 'repository', targetId: repo.id, outcome: 'denied', detail: gate.reason ?? null });
        res.status(403).json({ error: gate.reason, requiresApproval: true });
        return;
      }
    }

    const { openInIde, openInTerminal } = await import('../services/git.js');
    const result = target === 'terminal' ? await openInTerminal(repo.localPath) : await openInIde(repo.localPath);
    services.audit.record({
      actor, action: `repo.open_${target}`, targetKind: 'repository', targetId: repo.id,
      outcome: result.ok ? 'ok' : 'error', detail: result.ok ? `opened via ${result.method}` : result.error ?? 'failed',
    });
    res.status(result.ok ? 200 : 400).json(result);
  }));

  // ---- Seed (demo data) --------------------------------------------------------------------------

  router.post('/seed', wrap(async (req, res) => {
    if (!isEmpty(services.db) && req.body?.force !== true) {
      res.status(400).json({ error: 'Database is not empty. Pass { "force": true } to reseed (not implemented as destructive).' });
      return;
    }
    await seed(services, actorOf(req));
    res.json({ ok: true });
  }));

  return router;
}
