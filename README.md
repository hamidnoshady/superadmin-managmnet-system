# Development Command Center

One control center for all development projects, local repositories, GitHub issues and
pull requests, coding LLMs/agents, and Biza Miz superadmin bug reports and support
tickets — with evidence-backed status and human control over consequential changes.

Built according to [issue #1](https://github.com/hamidnoshady/superadmin-managmnet-system/issues/1)
(Windows-first, local-first plan). Current delivery: **Phase 1 complete, Phase 2
groundwork in place** — see [docs/roadmap.md](docs/roadmap.md).

## Principles

- **One control center**, multiple projects/repositories/providers, one traceable workflow.
- **Local-first**: SQLite in `.dcc/` — no cloud backend required for basic management.
- **GitHub is the source of truth** for issues/PRs; internal task state stays separate.
- **Evidence-backed status**: nothing claims success without evidence; every status shows
  its source, timestamp, and confidence (`confirmed` / `inferred` / `stale` / `unavailable`).
- **Human control**: external writes, merges, releases, deploys, destructive git and LLM
  sends are approval-gated by default and fully audited.
- **Never** silently discard local changes, overwrite work, expose credentials, or mix
  tenant-sensitive support data.

## Quick start

```bash
npm install          # builds @dcc/core automatically
npm test             # core + worker test suites (61 tests)
npm run dev:worker   # API + persistence on :8787 (auto-seeds demo data on first run)
npm run dev:ui       # UI on :5173 (proxies /api to the worker)
```

Open http://localhost:5173 — the Command Center dashboard summarizes projects, work
states, GitHub activity, support reports, agent runs, and the approval queue, each with
source and last-updated time.

## Modules

1. **Command Center** — what is being developed, what remains, what is blocked, what failed, what needs approval.
2. **Projects & Repositories** — manual registration + folder scan (read-only discovery), real Git state with uncommitted-change warnings.
3. **GitHub Operations** — issue/PR sync via `gh`, task linking, issue drafts with approval-gated creation.
4. **Biza Miz Support** — redacted intake (tenant hashes, secret stripping), rule-based triage, advisory duplicate detection, issue drafts.
5. **AI Brain & Agents** — pipeline stages (triage → investigation → plan → approval → implementation → testing → review → PR), run assignment, isolated worktrees.
6. **LLM / Provider Studio** — adapter registry (Claude Code, Codex, Arena, Freebuf-TBD, generic CLI, HTTP API, local models) with honest verification status.
7. **Runs, Logs & Evidence** — persisted run history, event logs, changed files, crash recovery (`interrupted` runs are visible, never faked).
8. **Settings, Security & Integrations** — scan roots, approval gates, audit trail, open verification items.

## Architecture

```
UI (React+TS, Tauri-ready) ──/api──▶ Worker (Node 22, supervised)
                                        ├── SQLite (.dcc/command-center.sqlite)
                                        ├── Git CLI (read-only discovery, worktree isolation)
                                        └── GitHub via gh (read sync + approval-gated writes)
```

Details: [docs/architecture.md](docs/architecture.md) ·
Integration status: [docs/integration-matrix.md](docs/integration-matrix.md) ·
Discovery notes & open questions: [docs/discovery.md](docs/discovery.md) ·
Windows packaging plan: [docs/windows-packaging.md](docs/windows-packaging.md)

## Repository layout

```
packages/core/   # domain logic (state machine, redaction, duplicates, approvals, status)
apps/worker/     # persistence, integrations, run monitor, REST API
apps/ui/         # the command center interface
docs/            # discovery, architecture, integration matrix, roadmap, packaging
```

## Honest scope

Items that cannot be verified from this environment stay explicitly marked: the existing
`D:\Development` app (owner-run inspection), the identity of "Freebuf", Biza Miz's
authenticated support API, and live Claude Code/Codex/Arena execution. Their adapters
exist but refuse to claim readiness — see the integration matrix.
