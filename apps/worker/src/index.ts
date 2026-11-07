/**
 * Development Command Center — worker process.
 *
 * The UI is NOT the owner of long-running state: this worker persists runs,
 * tasks, approvals and audit in SQLite and recovers from crashes/restarts.
 * It binds to 0.0.0.0 so desktop and browser previews can reach it.
 */
import express from 'express';
import { CONFIG, ensureDirs } from './config.js';
import { createServices, isEmpty, seed } from './services/seed.js';
import { buildRoutes } from './api/routes.js';

async function main(): Promise<void> {
  ensureDirs();
  const services = createServices();

  // Crash recovery: runs left "running" become "interrupted" — never silent success.
  const recovered = services.runs.recoverInterruptedRuns();
  if (recovered > 0) {
    console.log(`[worker] recovered ${recovered} interrupted run(s) from previous session`);
  }

  if (CONFIG.autoSeed && isEmpty(services.db)) {
    console.log('[worker] empty database — seeding demo workspace (disable with DCC_AUTO_SEED=0)');
    await seed(services);
  }

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // Browser/preview support: allow cross-origin reads of the API.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Actor,X-Policy-Approved');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.use('/api', buildRoutes(services));

  // Budget enforcement: running/queued runs that exceed their budget become
  // visible `timeout` failures — never silent successes.
  setInterval(() => {
    try {
      const timedOut = services.runs.enforceTimeouts();
      if (timedOut > 0) console.log(`[worker] marked ${timedOut} run(s) as timeout (budget exceeded)`);
    } catch (err) {
      console.error('[worker] timeout sweep failed:', err);
    }
  }, 30_000).unref();

  // Serve the built UI when present (desktop shell / single-process mode).
  app.use(express.static(new URL('../../ui/dist', import.meta.url).pathname));

  app.listen(CONFIG.port, CONFIG.host, () => {
    console.log(`[worker] Development Command Center worker listening on http://${CONFIG.host}:${CONFIG.port}`);
    console.log(`[worker] data dir: ${CONFIG.dataDir}`);
    console.log(`[worker] scan roots: ${CONFIG.defaultScanRoots.join(', ')}`);
    services.audit.record({
      actor: 'system', action: 'worker.start', targetKind: 'system', outcome: 'ok',
      detail: `Worker started on port ${CONFIG.port}`,
    });
  });
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
