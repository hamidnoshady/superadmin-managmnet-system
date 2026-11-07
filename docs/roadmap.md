# Roadmap — phased delivery (mapped to issue #1)

## Phase 0 — Discovery and integration verification

**Status: core discovery done in-sandbox; items requiring the owner's environment marked.**

- [x] Repository landscape + issue/PR inventory inspected before creating work
- [x] Runtime/toolchain discovery (Node 22, git, gh auth, no Rust) documented
- [x] Integration matrix produced with verified/unverified/unknown/unavailable states
- [ ] Inspect existing app at `D:\Development\arena development managment` (owner-run; checklist in discovery.md)
- [ ] Confirm Biza Miz API/webhook (owner) — ingestion channels are built and waiting for the verified endpoint
- [ ] Confirm "Freebuf" identity (owner)
- [ ] Decide minimum Windows versions/architectures (owner)

## Phase 1 — Useful command center ✅ (delivered)

- [x] Desktop-shell UI (React + TS, 8 modules, Tauri-ready) + global search
- [x] Local persistence (SQLite via `node:sqlite`, WAL, versioned schema + additive migrations)
- [x] Project & repository registry (manual registration + folder scan, never modifies targets)
- [x] Real Git status (branch, commit, dirty staged/unstaged/untracked, ahead/behind, detached)
- [x] Open repository in configured IDE (audited) or terminal (approval-gated)
- [x] GitHub issue/PR views + read sync via `gh`, per-repo checkpoints, visible sync errors
- [x] Unified task tracking with separated status tracks + dependency graph
- [x] Provider registry with capability matrix and honest verification checks
- [x] First verified coding-tool adapter (generic CLI runner, read-only evidence commands)
- [x] Run monitor: persistence, event logs, changed files, cancellation, attempts/retries
- [x] Crash recovery: interrupted runs recovered as `interrupted`, never as success
- [x] Approval queue (default-deny) + append-only audit trail
- [x] Evidence-backed dashboard (source + timestamp + confidence on every status)
- [x] Tests: 115 across core + worker (grew with each phase)

## Phase 2 — Support intelligence ✅ (delivered except live channel)

- [x] Biza Miz support module with manual/import intake
- [x] **Ingestion channels built**: authenticated API pull (auto-configured, honest unconfigured/unavailable states), signed webhook receiver (rejects unauthenticated payloads), JSON bulk import — all through the same redaction pipeline
- [x] Diagnostic redaction on intake (secrets stripped, tenant refs HMAC-hashed)
- [x] Rule-based triage suggestions (advisory, human-confirmable)
- [x] Duplicate/relationship detection (advisory ranking with rationale; never auto-discards)
- [x] Evidence-backed issue drafts (context, impact, repro, expected/actual, evidence, acceptance criteria, implementation plan, test requirements) with approval-gated creation
- [x] Triage/investigation/planning agents (AI brain pipeline with shared findings graph; untrusted content fenced + injection findings recorded; LLM participation disclosed honestly)
- [x] Resolution sync-back path: local resolution with evidence + `postResolution` channel (honest unavailability until the live endpoint is verified) + GitHub issue comment/close behind `issue_comment`/`issue_close` approval gates
- [ ] Live Biza Miz ingestion flip-on (blocked on owner verifying the endpoint/permissions — the adapter refuses fake data meanwhile)

## Phase 3 — Coordinated coding ✅ (delivered)

- [x] Shared task/evidence/findings graph (tasks, links, evidence, brain_findings, runs in one store)
- [x] Isolated worktrees per run (verified against real git) — parallel agents cannot overwrite each other
- [x] Coordinator: assignment with policy checks, capability-based recommendations, budget enforcement
- [x] Conflict detection: second active run on a task refused; overlapping-file warnings across parallel runs on a repo
- [x] Dependency gating: implementation+ stages blocked until upstream tasks are done
- [x] Test execution in the worktree with output mapped to acceptance criteria as evidence (failures visible)
- [x] Independent review stage (secrets-in-diff blockers, debug leftovers, evidence/criteria coverage, test results) with persisted verdict
- [x] PR preparation from evidence + criteria coverage, approval-gated `gh pr create` execution
- [x] CI/review status visibility from synced PR data; release readiness board
- [x] Timeout budgets (overdue runs → `timeout`), bounded retries with linked chains, crash recovery
- [x] LLM-backed coding agents: real adapters for Claude Code CLI and OpenAI Codex CLI (isolated worktree required, redacted fenced prompts, changed-files + output as evidence, success only on exit 0) plus text-only HTTP-API/local-model adapters — each adapter's readiness is probed per host and never assumed

## Phase 4 — Advanced automation ✅ (delivered)

- [x] Provider adapter framework (cli/api/browser/local_model) with verification-gated readiness and honest refusals
- [x] Configurable workflows: per-project autonomy levels 0–3, required stages, retry limits, allowed providers
- [x] Capability-based assignment recommendations (explicitly inferred; owner decides)
- [x] Engineering health metrics (cycle time, run success rate, evidence coverage, quality signals)
- [x] Release/deployment visibility (readiness verdict, blockers, CI concerns)
- [x] Backup/restore with validation + approval-gated destructive restore
- [x] Multi-device handoff primitive: workspace bundle export/import
- [x] Optional remote bundle sync: explicit owner-triggered push/pull against a configured endpoint (no background service; pulled bundles validated before install; DB restore stays behind the `restore_backup` gate)
- [x] Browser automation kept behind an adapter interface (planned; never bypasses authentication)

## Phase 5 — Remaining implementations ✅ (delivered)

- [x] LLM-assisted pipeline stages (triage) through the redaction/secret gate, with honest `usedLlm` disclosure and deterministic fallback
- [x] Autonomy ≥ 2 unattended implementation flow: implementation → tests → independent review → PR preparation in one guarded run; PR **creation** stays approval-gated; nothing merges/releases unattended
- [x] GitHub CI checks sync (`check-runs` → `no_checks/pending/failing/passing`) with PR head-SHA tracking
- [x] Resolution sync-back (support → local resolve → optional Biza Miz API post + gated GitHub issue comment/close)
- [x] OS-protected secret store (Windows Credential Manager via P/Invoke on Windows; session-env + 0600 fallback file elsewhere; values never in SQLite/logs/prompts/bundles)
- [x] LLM endpoint configuration (`llm_providers` settings: baseUrl/model/apiKeyEnv/style — env var NAMES only)
- [x] Tauri/Windows desktop scaffold (`apps/ui/src-tauri`) — **scaffold only, uncompiled in the sandbox**; verify on a Windows host before distribution

## Acceptance criteria coverage (issue #1 §12)

| Criterion | State |
|---|---|
| Registered projects/repos in one dashboard without moving/modifying them | ✅ |
| Repo/branch status from actual Git state; warns about uncommitted changes | ✅ |
| GitHub issues/PRs link to internal tasks and evidence | ✅ |
| Owner can select repository and verified provider for a task | ✅ |
| Agent run state/logs/changed-files persist across restart | ✅ |
| Dashboard distinguishes active/blocked/failed/completed/stale/unverified | ✅ |
| Support reports traceable to investigations and GitHub issues, tenant-safe | ✅ (linking + drafts + task graph; live Biza Miz two-way sync pending API) |
| Agents produce evidence-backed findings and issue drafts | ✅ (pipeline findings + templates; LLM stages activate on verified providers) |
| Duplicate detection advisory, never silently discards | ✅ |
| Consequential GitHub/deploy ops respect approval policy | ✅ (issues, PRs, restores, terminal launches, policy changes) |
| Parallel agents cannot silently overwrite work | ✅ (worktrees + conflict detection tested) |
| Secrets and sensitive support data protected/redacted | ✅ (intake + outbound gates, injection detection) |
| Disconnected providers/failed integrations clearly visible | ✅ |
| Completed tasks have verifiable evidence mapped to acceptance criteria | ✅ (enforced + coverage mapping in PR prep) |
| Tests cover interruption/recovery, conflicts, permissions, stale sync, untrusted input | ✅ (115 tests) |
