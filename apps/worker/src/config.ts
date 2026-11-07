import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repository root (workspace root), regardless of where the worker is started from. */
export const REPO_ROOT = path.resolve(here, '..', '..', '..');

const dataDir = path.resolve(process.env.DCC_DATA_DIR ?? path.join(REPO_ROOT, '.dcc'));
export const CONFIG = {
  port: Number(process.env.DCC_PORT ?? 8787),
  host: process.env.DCC_HOST ?? '0.0.0.0',
  dataDir,
  dbPath: path.join(dataDir, 'command-center.sqlite'),
  logDir: path.join(dataDir, 'logs'),
  worktreeDir: path.join(dataDir, 'worktrees'),
  /** Configured folder roots scanned for local projects (Windows-first default). */
  defaultScanRoots:
    process.env.DCC_SCAN_ROOTS?.split(path.delimiter).filter(Boolean) ??
    (process.platform === 'win32' ? ['D:\\Development'] : [path.join(REPO_ROOT, '..')]),
  staleAfterMinutes: Number(process.env.DCC_STALE_MINUTES ?? 60),
  autoSeed: process.env.DCC_AUTO_SEED !== '0',
};

export function ensureDirs(): void {
  for (const dir of [CONFIG.dataDir, CONFIG.logDir, CONFIG.worktreeDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
