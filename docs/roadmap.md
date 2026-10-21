# Roadmap — phased delivery (mapped to issue #1)

## Phase 0 — Discovery and integration verification

**Status: core discovery done in-sandbox; 2 items require the owner's Windows machine.**

- [x] Repository landscape + issue/PR inventory inspected before creating work
- [x] Runtime/toolchain discovery (Node 22, git, gh auth, no Rust) documented
- [x] Integration matrix produced with verified/unverified/unknown/unavailable states
- [ ] Inspect existing app at `D:\Development\arena development managment` (owner-run; checklist in discovery.md)
- [ ] Confirm Biza Miz API/webhook (owner)
- [ ] Confirm "Freebuf" identity (owner)
- [ ] Decide minimum Windows versions/architectures (owner)

## Phase 1 — Useful command center ✅ (delivered)

- [x] Desktop-shell UI (React + TS, 8 modules, Tauri-ready)
- [x] Local persistence (SQLite via `node:sqlite`, WAL, versioned schema)
- [x] Project & repository registry (manual registration + folder scan, never modifies targets)
- [x] Real Git status (branch, commit, dirty with staged/unstaged/untracked, ahead/behind, detached)
- [x] GitHub issue/PR views + read sync via `gh`, per-repo sync checkpoints and visible sync errors
- [x] Unified task tracking with separated status tracks (internal / github / agent / test / pr / deploy)
- [x] Provider registry with capability matrix and honest verification checks
- [x] First verified coding-tool adapter (generic CLI runner, read-only evidence commands)
- [x] Run monitor with persistence, event logs, changed-file summaries, cancellation
- [x] Crash recovery: interrupted runs are recovered as `interrupted`, never as success
- [x] Approval queue with default-deny gates for consequential actions
- [x] Secure configuration (secrets out of the database; approval policy; scan roots)
- [x] Append-only audit trail
- [x] Dashboard with source + timestamp + confidence on every status (confirmed/inferred/stale/unavailable)
- [x] Tests: state machine, redaction, duplicates, approvals, git parsing + real git, runs/recovery, support intake

## Phase 2 — Support intelligence 🟡 (groundwork delivered)

- [x] Biza Miz support module with manual/import intake (`channel` field ready for api/webhook/browser)
- [x] Diagnostic redaction on intake (secrets stripped, tenant refs hashed)
- [x] Rule-based triage suggestions (advisory, human-confirmable)
- [x] Duplicate/relationship detection (advisory ranking with rationale; never auto-discards)
- [x] Evidence-backed issue drafts from redacted content, approval-gated creation
- [ ] Live Biza Miz ingestion (blocked on API/webhook verification)
- [ ] Triage/investigation/planning agents (needs verified LLM provider first)
- [ ] Resolution sync back to Biza Miz (blocked on permissions/interface)

## Phase 3 — Coordinated coding (planned)

- [x] Shared task/evidence graph foundation (tasks, links, evidence, runs in one store)
- [x] Isolated worktrees per run (verified against real git)
- [ ] Coordinator agent + role orchestration (triage/investigation/planning/implementation/testing/review)
- [ ] Multiple concurrent coding agents with overlapping-file conflict detection
- [ ] Automated tests mapped to acceptance criteria per run
- [ ] Independent review stage + PR preparation
- [ ] CI monitoring and release readiness
- [ ] Full retry/timeout/crash-recovery matrix for long agent runs

## Phase 4 — Advanced automation (planned)

- [ ] More provider adapters (Claude Code, Codex, Arena, local models) — each behind verification
- [ ] Configurable workflows / per-project autonomy policies
- [ ] Capability-based assignment recommendations
- [ ] Engineering health metrics
- [ ] Release/deployment visibility
- [ ] Optional multi-device/team sync

## Acceptance criteria coverage (issue #1 §12)

| Criterion | State |
|---|---|
| Registered projects/repos in one dashboard without moving/modifying them | ✅ |
| Repo/branch status from actual Git state; warns about uncommitted changes | ✅ |
| GitHub issues/PRs link to internal tasks and evidence | ✅ (sync + links; evidence attachment API) |
| Owner can select repository and verified provider for a task | ✅ |
| Agent run state/logs/changed-files persist across restart | ✅ |
| Dashboard distinguishes active/blocked/failed/completed/stale/unverified | ✅ |
| Support reports traceable to investigations and GitHub issues, tenant-safe | 🟡 (local trace + drafts; live Biza Miz link pending API) |
| Agents produce evidence-backed findings and issue drafts | 🟡 (evidence + drafts yes; LLM agents pending verified providers) |
| Duplicate detection advisory, never silently discards | ✅ |
| Consequential GitHub/deploy ops respect approval policy | ✅ |
| Parallel agents cannot silently overwrite work | ✅ (isolated worktrees verified) |
| Secrets and sensitive support data protected/redacted | ✅ |
| Disconnected providers/failed integrations clearly visible | ✅ |
| Completed tasks have verifiable evidence mapped to acceptance criteria | ✅ (enforced + advisory mapping) |
| Tests cover interruption/recovery, conflicts, permissions, stale sync, untrusted input | ✅ (core suite; expand in phase 3) |
