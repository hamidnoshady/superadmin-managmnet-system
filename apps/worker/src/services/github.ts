import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GithubIssue, GithubPullRequest } from '@dcc/core';
import { redact, assertSafeForOutbound } from '@dcc/core';
import { Database, newId, nowIso } from '../db/database.js';
import { parseGithubRemote } from './git.js';
import type { AuditService } from './audit.js';

const execFileAsync = promisify(execFile);

export interface GithubAuthStatus {
  available: boolean;
  method: 'gh_cli' | 'token_env' | 'unconfigured';
  account: string | null;
  notes: string;
  checkedAt: string;
}

/**
 * GitHub integration via the official `gh` CLI.
 *
 * GitHub is the source of truth for issues/PRs; internal task state stays
 * distinct. All writes go through approval gates (enforced by the caller) and
 * every action is audited. Content is redacted before it leaves the machine.
 */
export class GithubService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async checkAuth(): Promise<GithubAuthStatus> {
    const checkedAt = nowIso();
    const hasTokenEnv = Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'status'], { timeout: 10_000 });
      // gh writes status to stderr normally; stdout may be empty. Treat exit 0 as authenticated.
      void stdout;
      return {
        available: true,
        method: 'gh_cli',
        account: null,
        notes: 'gh CLI authenticated (verified this session). Least-privilege scopes are the owner\'s responsibility.',
        checkedAt,
      };
    } catch {
      if (hasTokenEnv) {
        return {
          available: true,
          method: 'token_env',
          account: null,
          notes: 'GH_TOKEN/GITHUB_TOKEN present in environment; gh CLI auth check failed.',
          checkedAt,
        };
      }
      return {
        available: false,
        method: 'unconfigured',
        account: null,
        notes: 'No GitHub authentication available. GitHub sync disabled — shown as unavailable, never as healthy.',
        checkedAt,
      };
    }
  }

  private async ghApi(endpoint: string): Promise<unknown> {
    const { stdout } = await execFileAsync('gh', ['api', endpoint, '--paginate'], {
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    // --paginate concatenates JSON arrays (one per page): [..] [..] — split and flatten.
    const chunks = stdout.trim();
    if (!chunks) return [];
    const pages = chunks.split(/(?<=\])\s*(?=\[)/).map((part) => JSON.parse(part) as unknown[]);
    return pages.flat();
  }

  /** Pure mapping from gh api JSON → stored rows (unit tested offline). */
  static mapIssue(raw: Record<string, unknown>, repoId: string): GithubIssue {
    const labels = Array.isArray(raw.labels)
      ? (raw.labels as Array<Record<string, unknown> | string>).map((l) => (typeof l === 'string' ? l : String(l.name ?? '')))
      : [];
    const assignees = Array.isArray(raw.assignees) ? (raw.assignees as Array<Record<string, unknown>>).map((a) => String(a.login ?? '')) : [];
    const milestone = raw.milestone && typeof raw.milestone === 'object' ? String((raw.milestone as Record<string, unknown>).title ?? '') : null;
    return {
      id: newId('ghi'),
      repoId,
      number: Number(raw.number),
      title: String(raw.title ?? ''),
      state: raw.state === 'closed' ? 'closed' : 'open',
      labels,
      assignees,
      milestone: milestone || null,
      author: String((raw.user as Record<string, unknown> | undefined)?.login ?? ''),
      url: String(raw.html_url ?? ''),
      updatedAt: String(raw.updated_at ?? nowIso()),
      syncedAt: nowIso(),
    };
  }

  static mapPullRequest(raw: Record<string, unknown>, repoId: string): GithubPullRequest {
    const merged = raw.merged_at != null;
    return {
      id: newId('ghp'),
      repoId,
      number: Number(raw.number),
      title: String(raw.title ?? ''),
      state: merged ? 'merged' : raw.state === 'closed' ? 'closed' : 'open',
      draft: Boolean(raw.draft),
      reviewDecision: (raw.review_decision as string | null) ?? null,
      mergeable: raw.mergeable == null ? null : String(raw.mergeable),
      ciStatus: (raw.mergeable_state as string | null) ?? null,
      url: String(raw.html_url ?? ''),
      updatedAt: String(raw.updated_at ?? nowIso()),
      syncedAt: nowIso(),
    };
  }

  /**
   * Sync issues + PRs for a registered repository. Read-only. Failures are
   * recorded per-repo so the dashboard can show the integration as unavailable.
   */
  async syncRepo(repo: { id: string; githubOwner: string | null; githubRepo: string | null; remoteUrl: string | null }): Promise<{
    ok: boolean;
    issues: number;
    prs: number;
    error?: string;
  }> {
    const gh = repo.githubOwner && repo.githubRepo ? { owner: repo.githubOwner, repo: repo.githubRepo } : parseGithubRemote(repo.remoteUrl);
    if (!gh) {
      const error = 'Repository has no GitHub remote — cannot sync';
      this.markSyncError(repo.id, error);
      return { ok: false, issues: 0, prs: 0, error };
    }
    try {
      const issuesRaw = (await this.ghApi(`repos/${gh.owner}/${gh.repo}/issues?state=all&per_page=50`)) as Record<string, unknown>[];
      const prsRaw = (await this.ghApi(`repos/${gh.owner}/${gh.repo}/pulls?state=all&per_page=50`)) as Record<string, unknown>[];

      // The issues endpoint also returns PRs — filter them out (they have pull_request key).
      const issues = issuesRaw.filter((i) => i.pull_request == null).map((i) => GithubService.mapIssue(i, repo.id));
      const prs = prsRaw.map((p) => GithubService.mapPullRequest(p, repo.id));

      this.db.transaction(() => {
        for (const issue of issues) {
          this.db.run(
            `INSERT INTO github_issues (id, repo_id, number, title, state, labels, assignees, milestone, author, url, updated_at, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(repo_id, number) DO UPDATE SET
               title = excluded.title, state = excluded.state, labels = excluded.labels,
               assignees = excluded.assignees, milestone = excluded.milestone,
               updated_at = excluded.updated_at, synced_at = excluded.synced_at`,
            issue.id, repo.id, issue.number, issue.title, issue.state,
            JSON.stringify(issue.labels), JSON.stringify(issue.assignees), issue.milestone,
            issue.author, issue.url, issue.updatedAt, issue.syncedAt,
          );
        }
        for (const pr of prs) {
          this.db.run(
            `INSERT INTO github_prs (id, repo_id, number, title, state, draft, review_decision, mergeable, ci_status, url, updated_at, synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(repo_id, number) DO UPDATE SET
               title = excluded.title, state = excluded.state, draft = excluded.draft,
               review_decision = excluded.review_decision, mergeable = excluded.mergeable,
               ci_status = excluded.ci_status, updated_at = excluded.updated_at, synced_at = excluded.synced_at`,
            pr.id, repo.id, pr.number, pr.title, pr.state, pr.draft ? 1 : 0,
            pr.reviewDecision, pr.mergeable, pr.ciStatus, pr.url, pr.updatedAt, pr.syncedAt,
          );
        }
        this.db.run(
          `INSERT INTO sync_checkpoints (id, repo_id, resource, last_sync_at, last_error, status)
           VALUES (?, ?, 'github', ?, NULL, 'ok')
           ON CONFLICT(repo_id, resource) DO UPDATE SET last_sync_at = excluded.last_sync_at, last_error = NULL, status = 'ok'`,
          newId('sync'), repo.id, nowIso(),
        );
      });

      this.audit.record({
        actor: 'user:sync',
        action: 'github.sync',
        targetKind: 'repository',
        targetId: repo.id,
        outcome: 'ok',
        detail: `Synced ${issues.length} issues, ${prs.length} PRs from ${gh.owner}/${gh.repo}`,
      });
      return { ok: true, issues: issues.length, prs: prs.length };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.markSyncError(repo.id, error);
      return { ok: false, issues: 0, prs: 0, error };
    }
  }

  private markSyncError(repoId: string, error: string): void {
    this.db.run(
      `INSERT INTO sync_checkpoints (id, repo_id, resource, last_sync_at, last_error, status)
       VALUES (?, ?, 'github', ?, ?, 'error')
       ON CONFLICT(repo_id, resource) DO UPDATE SET last_sync_at = excluded.last_sync_at, last_error = excluded.last_error, status = 'error'`,
      newId('sync'), repoId, nowIso(), redact(error).redacted,
    );
    this.audit.record({
      actor: 'user:sync',
      action: 'github.sync',
      targetKind: 'repository',
      targetId: repoId,
      outcome: 'error',
      detail: redact(error).redacted,
    });
  }

  /**
   * Create a GitHub issue. ONLY called after the approval gate has passed.
   * Content is redacted and asserted safe before leaving the machine.
   */
  async createIssue(
    repo: { id: string; githubOwner: string | null; githubRepo: string | null; remoteUrl: string | null },
    title: string,
    body: string,
    labels: string[],
    actor: string,
  ): Promise<{ ok: boolean; url?: string; error?: string }> {
    const gh = repo.githubOwner && repo.githubRepo ? { owner: repo.githubOwner, repo: repo.githubRepo } : parseGithubRemote(repo.remoteUrl);
    if (!gh) return { ok: false, error: 'No GitHub remote' };

    const safeTitle = redact(title).redacted;
    const safeBody = redact(body).redacted;
    try {
      assertSafeForOutbound(`${safeTitle}\n${safeBody}`);
    } catch (err) {
      this.audit.record({
        actor, action: 'github.issue_create', targetKind: 'repository', targetId: repo.id,
        outcome: 'denied', detail: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const args = ['issue', 'create', '--repo', `${gh.owner}/${gh.repo}`, '--title', safeTitle, '--body', safeBody];
      if (labels.length > 0) args.push('--label', labels.join(','));
      const { stdout } = await execFileAsync('gh', args, { timeout: 30_000 });
      const url = stdout.trim().split('\n').pop() ?? '';
      this.audit.record({
        actor,
        action: 'github.issue_create',
        targetKind: 'repository',
        targetId: repo.id,
        outcome: 'ok',
        detail: `Created issue: ${url}`,
      });
      return { ok: true, url };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.audit.record({ actor, action: 'github.issue_create', targetKind: 'repository', targetId: repo.id, outcome: 'error', detail: redact(error).redacted });
      return { ok: false, error: redact(error).redacted };
    }
  }

  listIssues(repoId: string): GithubIssue[] {
    return this.db
      .query<Record<string, unknown>>('SELECT * FROM github_issues WHERE repo_id = ? ORDER BY number DESC', repoId)
      .map((row) => ({
        id: String(row.id),
        repoId: String(row.repo_id),
        number: Number(row.number),
        title: String(row.title),
        state: row.state as 'open' | 'closed',
        labels: JSON.parse(String(row.labels)),
        assignees: JSON.parse(String(row.assignees)),
        milestone: (row.milestone as string) ?? null,
        author: String(row.author),
        url: String(row.url),
        updatedAt: String(row.updated_at),
        syncedAt: String(row.synced_at),
      }));
  }

  listPullRequests(repoId: string): GithubPullRequest[] {
    return this.db
      .query<Record<string, unknown>>('SELECT * FROM github_prs WHERE repo_id = ? ORDER BY number DESC', repoId)
      .map((row) => ({
        id: String(row.id),
        repoId: String(row.repo_id),
        number: Number(row.number),
        title: String(row.title),
        state: row.state as GithubPullRequest['state'],
        draft: Number(row.draft) === 1,
        reviewDecision: (row.review_decision as string) ?? null,
        mergeable: (row.mergeable as string) ?? null,
        ciStatus: (row.ci_status as string) ?? null,
        url: String(row.url),
        updatedAt: String(row.updated_at),
        syncedAt: String(row.synced_at),
      }));
  }
}
