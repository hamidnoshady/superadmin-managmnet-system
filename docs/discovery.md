# Phase 0 — Discovery & Inventory

Status: **in progress** (started 2026-10-21). The issue requires discovery before broad
implementation. This document records what was inspected, with evidence, and marks every
unknown explicitly. Items that cannot be inspected from the build sandbox are listed as
`UNAVAILABLE` and are **not** guessed at.

## 1. Existing local application (`D:\Development\arena development managment`)

**Status: UNAVAILABLE — cannot be inspected from this environment.**

The existing local tool lives on the owner's Windows machine. The development sandbox is a
Linux checkout of this repository only, with no access to `D:\`. Per the issue's own rule
("Mark unknowns explicitly"), no assumption is made about its architecture, data, or
reusable components.

Consequences:
- No reuse decisions have been made yet.
- The new system is built as a **separate, non-destructive** application. Discovery and
  registration never move, modify, or overwrite external projects.
- Action for the owner: run the inspection checklist below on the Windows machine and
  record the answers here (or open a follow-up issue).

### Inspection checklist for the existing app (owner-run)

- [ ] Runtime/stack (Electron? WPF? web app? scripts?)
- [ ] Where it stores local data (files? SQLite? registry?)
- [ ] Current feature list (projects, git, github, agents, support?)
- [ ] Integrations in use (GitHub auth? LLM APIs? browser automation?)
- [ ] Limitations and failure modes experienced
- [ ] Components worth reusing (data exports, project lists, settings)
- [ ] Any credentials/secrets stored in it, and how

## 2. Repository landscape

**Status: VERIFIED (2026-10-21).**

- `hamidnoshady/superadmin-managmnet-system` (this repo): issues enabled, public,
  default branch `main`, 1 open issue (issue #1 — this plan), 0 PRs at discovery time.
- Issue/PR inventory was fetched via `gh` before creating any follow-up work; no
  duplicate planning issues exist.
- Local checkout: `/home/user/superadmin-managmnet-system` on branch `arena/a56567ad-…`,
  clean at discovery start.

## 3. Provider / coding-tool interfaces

**Status: PARTIALLY VERIFIED — see [integration-matrix.md](./integration-matrix.md).**

| Tool | Discovery result |
|---|---|
| Generic CLI execution (git/shell, read-only) | **VERIFIED** — executed here; evidence captured |
| GitHub via `gh` CLI | **VERIFIED** — authenticated as the repo owner; read sync tested end-to-end |
| Claude Code | **UNVERIFIED** — binary/login not present in sandbox; adapter refuses to claim ready |
| OpenAI Codex CLI | **UNVERIFIED** — binary/login not present in sandbox |
| Arena AI | **UNKNOWN** — integration surface not documented yet |
| Freebuf | **UNKNOWN IDENTITY** — per the issue: "Confirm what Freebuf refers to before implementing its adapter". No adapter implemented; provider entry is disabled |
| Local model server (Ollama-style) | **UNAVAILABLE** — nothing listening locally; checked at runtime |
| HTTP API models (generic) | **UNVERIFIED** — needs endpoint + key in OS-protected store |

## 4. Biza Miz superadmin support / bug-report flows

**Status: UNAVAILABLE (authenticated API not reachable from this environment).**

- No authenticated API endpoint, webhook, or documented interface is available to this
  sandbox. Direct production database access is explicitly rejected as a default
  integration (per the issue).
- Therefore Phase-2 groundwork is built against **manual/import intake** with the channel
  field ready for `api` / `webhook` / `browser_adapter` once a verified interface exists.
- Tenant isolation is already enforced in the data model: raw tenant references are never
  stored — only salted HMAC hashes. All outbound content (LLM prompts, GitHub issues) is
  redacted first, with a final "assert safe" gate.
- Action for the owner: confirm whether Biza Miz exposes an authenticated support/bug API
  or webhook and what permissions it grants.

## 5. OS targets & packaging

**Status: UNDECIDED — marked explicitly.**

- The issue proposes Windows-first with Tauri + React + TypeScript + Rust.
- This sandbox has Node 22 and no Rust toolchain, so the desktop shell is delivered as a
  **Tauri-ready web UI + local worker** architecture: the UI never owns long-running state;
  the worker persists runs/tasks/audit in SQLite and survives restarts. Tauri packaging
  wraps this same UI later (see [windows-packaging.md](./windows-packaging.md)).
- Minimum supported Windows version / CPU architecture is still an open decision for the
  owner (affects WebView2 requirements and arm64 builds).

## 6. Security requirements gathered from the plan

- Least-privilege GitHub access; explicit provider permissions.
- OS-protected secret storage (Windows Credential Manager on Windows; env/session on
  other OSes). Secrets never appear in prompts, issue bodies, logs, or bundles.
- Approval gates for external writes, destructive Git, merges, releases, deploys — on by
  default; relaxing a gate is itself an audited, approval-gated action.
- Append-only audit trail for user decisions and agent actions.
- Untrusted input handling: issue text, support tickets, logs and repo files must not be
  able to override system policy; outbound content passes redaction + assertion.

## 7. Environment facts used for architecture validation (verified)

| Fact | Value | Evidence |
|---|---|---|
| Node runtime | v22.22.3 with built-in `node:sqlite` | `node --version`, sqlite smoke test |
| Git CLI | 2.39.5 | `git --version` |
| GitHub CLI | 2.23.0, authenticated | `gh auth status` |
| Rust/cargo | not installed | `cargo --version` → not found |
| SQLite | via `node:sqlite` (no native compile needed) | worker tests pass |
| npm registry | reachable | `npm install` succeeded |
