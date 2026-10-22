# Architecture (validated against available runtimes)

This is the Phase-1 architecture as built, validated where possible in the current
environment. Anything unverified is marked and does not pretend to work.

## Shape

```
┌────────────────────────────────────────────────────────────┐
│  Desktop UI (React + TypeScript, Vite)                     │
│  8 modules: Command Center · Projects & Repos · GitHub ·   │
│  Biza Miz Support · AI Brain & Agents · Provider Studio ·  │
│  Runs/Logs/Evidence · Settings & Security                  │
│                                                            │
│  • Read-only consumer of the worker API                    │
│  • Never owns long-running agent processes                 │
└──────────────────────────┬─────────────────────────────────┘
                           │  same-origin /api (proxied)
┌──────────────────────────▼─────────────────────────────────┐
│  Worker (Node 22 + Express + TS)                           │
│  • Supervised process: survives UI restarts                │
│  • Crash recovery: running runs → "interrupted"            │
│  • Services: registry, git, github, tasks, runs,           │
│    providers, support, approvals, audit, dashboard         │
│  • Provider adapters: cli / api / browser / local_model    │
└──────┬───────────────┬───────────────────┬─────────────────┘
       │               │                   │
┌──────▼─────┐  ┌──────▼──────┐   ┌────────▼────────┐
│ SQLite     │  │ Git CLI     │   │ GitHub via gh   │
│ (local,    │  │ (read-only  │   │ (read sync +    │
│  WAL)      │  │  discovery, │   │  approval-gated │
│            │  │  worktrees) │   │  writes)        │
└────────────┘  └─────────────┘   └─────────────────┘
```

Packages:

- `packages/core` — pure domain logic, fully unit-tested: task state machine, redaction
  pipeline, advisory duplicate detection, sourced/stale status, approval policy,
  evidence↔criteria mapping. Shared by worker and UI.
- `apps/worker` — persistence + integrations + run monitor + REST API.
- `apps/ui` — Vite + React + TS interface (Tauri-ready).

## Stack decisions (from the issue's proposed direction, validated here)

| Proposed | Decision | Validation |
|---|---|---|
| Tauri + React + TS desktop UI | **React + TS now, Tauri packaging later** | No Rust toolchain in this environment; the UI is standard web assets that Tauri can wrap without changes (see windows-packaging.md). Web build verified (`vite build` passes). |
| Rust desktop capabilities + supervised worker | **Node worker process instead of Rust** for now | Node 22 verified. The critical property — UI is not the owner of long-running state, worker persists and recovers — is implemented and tested (`runs.test.ts` crash-recovery test). A Rust sidecar can replace the worker later without changing the API. |
| SQLite local persistence | **`node:sqlite` (built-in), WAL mode, versioned schema** | Verified via worker test suite (persistence-across-restart test). No native compile step, which removes a whole class of Windows install failures. |
| Git CLI + supported GitHub APIs | **`git` CLI read-only + `gh` CLI/API** | Verified end-to-end: real git status parsing, worktree isolation, GitHub issue sync from the live API. |
| Modular provider adapters | **Adapter registry with honest verification** | Verified: unverified providers' runs fail explicitly, never fake success (`runs.test.ts`). |
| Windows Credential Manager / OS secret store | **Metadata in SQLite, secrets never in DB** | Enforced by design + redaction gate; actual Credential Manager integration is part of Windows packaging (unverified here). |

## Key invariants (enforced in code + tests)

1. **Evidence-backed status** — every dashboard value carries source, timestamp and
   confidence (`confirmed` / `inferred` / `stale` / `unavailable`). Failed integrations
   show as `unavailable`, never as healthy.
2. **Separated status tracks** — internal task status is stored independently from
   GitHub, agent, test, PR, and deployment status.
3. **Completion requires evidence** — the task state machine refuses `Completed` without
   linked evidence.
4. **Approval gates on by default** — external writes, merges, releases, deploys,
   destructive git, LLM sends, and policy relaxation all require explicit approval;
   every decision is audited.
5. **Isolation** — each coding run gets its own `git worktree` + branch under
   `.dcc/worktrees/`; parallel agents cannot overwrite one another's work. Discovery
   never modifies registered repositories.
6. **Redaction at the boundary** — support text is redacted on intake (tenant refs
   hashed, secrets stripped) and again on outbound (LLM/GitHub) with a final assertion
   that refuses to send high-risk leftovers.
7. **Truthful failures** — interrupted runs are recovered as `interrupted`, provider
   failures are recorded, sync errors persist per-repo; nothing is silently dropped.

## Data locations (all local, user-owned)

- SQLite: `.dcc/command-center.sqlite` (WAL)
- Run logs/events: in SQLite (`run_events`) + worker stdout
- Agent worktrees: `.dcc/worktrees/<run-id>`
- Audit trail: append-only `audit_log` table

## Runtime topology in dev

- Worker: `npm run dev:worker` → `0.0.0.0:8787` (REST `/api`)
- UI: `npm run dev:ui` → `0.0.0.0:5173` (proxies `/api` to the worker)
- The worker can also serve the built UI (`apps/ui/dist`) for single-process use.

## Not yet implemented (honest scope)

- Tauri packaging and Windows Credential Manager binding (documented, untested).
- Real coding-agent execution for Claude Code / Codex / Arena (adapters refuse until
  verified) — the coordinator, worktrees, retries, tests, review and PR prep around them
  are implemented and tested.
- Live Biza Miz ingestion flip-on (channels implemented: signed webhook receiver,
  authenticated API pull, JSON import; they refuse unverified/unconfigured input).
- Remote multi-device sync service (explicitly deferred by the issue); the workspace
  bundle export/import is the local-first handoff primitive.

## Phase 2–4 components (delivered)

- **AI Brain (`services/brain.ts`)** — pipeline over the shared findings graph:
  triage → investigation → planning → approval gate. Untrusted content is fenced
  (`core/untrusted.ts`) and injection attempts are recorded as findings. LLM
  participation is disclosed (`usedLlm: false` when no verified provider exists).
- **Coordinator (`services/coordinator.ts`)** — assignment with capability-based
  recommendations, project policy enforcement, conflict detection (same-task active
  runs refused; overlapping files warned), dependency gating, budget timeouts, bounded
  retries, test execution mapped to acceptance criteria, independent review
  (`core/review.ts`), PR preparation (`core/issueDraft.ts`) with approval-gated creation.
- **Ingestion (`services/ingest.ts`)** — Biza Miz channels: API pull (capability-checked),
  signed webhook (`x-dcc-webhook-secret`), JSON import; all through the redaction
  pipeline with batch records.
- **Health (`services/health.ts`)** — cycle time, run success rate, evidence coverage,
  discrepancy detection (`core/discrepancy.ts`), release readiness verdict.
- **Backup (`services/backup.ts`)** — SQLite online-backup bundles + manifests,
  validation before restore, approval-gated destructive restore.
