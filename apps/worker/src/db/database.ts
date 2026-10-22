/**
 * Local persistence — SQLite via Node's built-in `node:sqlite`.
 *
 * Product principle: local-first. All project/task/run/audit state lives in a
 * local database the user owns. Schema migrations are versioned and additive.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION, SCHEMA_SQL } from './schema.js';

// `node:sqlite` is loaded via createRequire so bundlers/test runners that do
// not know the builtin name leave it as a plain Node runtime require.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type DatabaseSyncHandle = import('node:sqlite').DatabaseSync;

export class Database {
  readonly db: DatabaseSyncHandle;
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(SCHEMA_SQL);
    const row = this.queryOne<{ user_version: number }>('PRAGMA user_version');
    const current = Number(row?.user_version ?? 0);
    if (current < SCHEMA_VERSION) {
      // Additive migrations only — never drop, rename, or rewrite user data.
      this.addColumnsIfMissing('runs', [
        ['attempt', 'INTEGER NOT NULL DEFAULT 1'],
        ['max_attempts', 'INTEGER NOT NULL DEFAULT 1'],
        ['retry_of', 'TEXT'],
        ['review_verdict', 'TEXT'],
      ]);
      this.addColumnsIfMissing('projects', [
        ['environment_refs', "TEXT NOT NULL DEFAULT '[]'"],
      ]);
      this.addColumnsIfMissing('github_prs', [
        ['head_sha', 'TEXT'],
      ]);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  /** Additive schema migration helper (idempotent). */
  private addColumnsIfMissing(table: string, columns: Array<[string, string]>): void {
    const existing = new Set(
      this.query<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name),
    );
    for (const [name, definition] of columns) {
      if (!existing.has(name)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    }
  }

  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...(params as never[])) as T[];
  }

  queryOne<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    const stmt = this.db.prepare(sql);
    return stmt.get(...(params as never[])) as T | undefined;
  }

  run(sql: string, ...params: unknown[]): { changes: number } {
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...(params as never[]));
    return { changes: Number(result.changes) };
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
