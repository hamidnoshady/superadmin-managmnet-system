import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Database, nowIso } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { CONFIG } from '../config.js';
import type { AuditService } from './audit.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

export interface BackupInfo {
  file: string;
  createdAt: string;
  sizeBytes: number;
  manifest: Record<string, unknown>;
}

/**
 * Backup / restore / workspace bundle export.
 *
 * The same bundle doubles as the multi-device handoff primitive (the issue
 * defers a remote sync service; an explicit export/import is the local-first
 * equivalent and stays under the owner's control).
 *
 * Restore is destructive to current local state → approval-gated.
 */
export class BackupService {
  private readonly backupDir: string;

  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {
    this.backupDir = path.join(CONFIG.dataDir, 'backups');
    fs.mkdirSync(this.backupDir, { recursive: true });
  }

  /** Export the live database to a timestamped backup + manifest (SQLite online backup). */
  async exportBundle(actor: string): Promise<BackupInfo> {
    const stamp = nowIso().replace(/[:.]/g, '-');
    const file = path.join(this.backupDir, `dcc-backup-${stamp}.sqlite`);
    const manifestFile = path.join(this.backupDir, `dcc-backup-${stamp}.json`);

    // Use SQLite's own backup API for a consistent snapshot of the live DB.
    const { backup } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
    await backup(this.db.db, file);

    const counts = {
      projects: this.count('projects'),
      repositories: this.count('repositories'),
      tasks: this.count('tasks'),
      runs: this.count('runs'),
      evidence: this.count('evidence'),
      support_reports: this.count('support_reports'),
      audit_log: this.count('audit_log'),
    };
    const manifest = {
      createdAt: nowIso(),
      schemaVersion: SCHEMA_VERSION,
      counts,
      note: 'Development Command Center local-state bundle. Secrets are never stored in this database.',
    };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

    this.audit.record({
      actor, action: 'backup.export', targetKind: 'system', targetId: file, outcome: 'ok',
      detail: `Exported ${JSON.stringify(counts)}`,
    });
    return { file, createdAt: manifest.createdAt, sizeBytes: fs.statSync(file).size, manifest };
  }

  list(): BackupInfo[] {
    return fs
      .readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.sqlite'))
      .sort()
      .reverse()
      .map((f) => {
        const file = path.join(this.backupDir, f);
        const manifestFile = file.replace(/\.sqlite$/, '.json');
        let manifest: Record<string, unknown> = {};
        try {
          manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        } catch {
          manifest = { note: 'manifest missing' };
        }
        return { file, createdAt: String(manifest.createdAt ?? fs.statSync(file).mtime.toISOString()), sizeBytes: fs.statSync(file).size, manifest };
      });
  }

  /**
   * Validate a backup file opens and has the expected tables. Safe read-only
   * check used before any restore.
   */
  validate(file: string): { ok: boolean; counts?: Record<string, number>; error?: string } {
    const abs = path.resolve(file);
    if (!abs.startsWith(this.backupDir)) {
      return { ok: false, error: 'Backup file must live in the configured backup directory' };
    }
    if (!fs.existsSync(abs)) return { ok: false, error: 'Backup file not found' };
    try {
      const snapshot = new DatabaseSync(abs);
      const counts: Record<string, number> = {};
      for (const table of ['projects', 'tasks', 'runs', 'audit_log']) {
        const row = snapshot.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        counts[table] = Number(row.n);
      }
      snapshot.close();
      return { ok: true, counts };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Restore a backup over the live database file. ONLY called after the
   * `restore_backup` approval gate has passed. The worker must be restarted
   * afterwards — this is stated in the response, not hidden.
   */
  restore(file: string, actor: string): { ok: boolean; error?: string; note?: string } {
    const validation = this.validate(file);
    if (!validation.ok) return { ok: false, error: validation.error };
    try {
      const target = path.resolve(this.db.filePath);
      // Close WAL cleanly before swapping files.
      this.db.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      fs.copyFileSync(path.resolve(file), target);
      this.audit.record({
        actor, action: 'backup.restore', targetKind: 'system', targetId: file, outcome: 'ok',
        detail: `Restored from ${path.basename(file)} — worker restart required to load restored state`,
      });
      return { ok: true, note: 'Backup restored. Restart the worker process to load the restored state.' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private count(table: string): number {
    return Number(this.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0);
  }
}
