# Integration Matrix

Every row states what has actually been verified, how authentication works, what
permissions are needed, known limitations, and implementation status. Unknowns stay
explicit — a provider is never displayed as ready until its execution path is tested.

Legend: **VERIFIED** = tested in this environment · **UNVERIFIED** = implementation exists
but path untested · **UNKNOWN** = identity/interface not confirmed · **UNAVAILABLE** =
checked and not reachable · **PLANNED** = not started.

| Integration | Capability | Auth method | Permissions needed | Execution | Limitations | Status |
|---|---|---|---|---|---|---|
| **Git CLI** | branch/commit/dirty/ahead/behind, worktree isolation, changed files | local user account | read on local repos; `worktree add/remove` under `.dcc/worktrees` | CLI subprocess | Read-only against registered repos by design; destructive commands flagged & gated | **VERIFIED** (2026-10-21) |
| **GitHub (gh CLI / REST)** | issues, PRs, labels, authors, sync checkpoints; approval-gated issue creation | `gh auth login` / `GH_TOKEN` | least-privilege repo scope; writes need approval | `gh api` / `gh issue create` | CI details limited to `mergeable_state` today; releases/deploy not implemented; write path tested only via approval gate logic (no live write performed) | **VERIFIED** read path (2026-10-21); write path **UNVERIFIED** (no live write attempted) |
| **Local SQLite** | projects, repos, tasks, runs, evidence, approvals, audit, support reports | none (local file) | file system access to `.dcc/` | `node:sqlite` (WAL) | Single-writer; backup/restore is file-copy (documented, not automated) | **VERIFIED** (2026-10-21) |
| **Generic CLI runner** | safe read-only evidence commands (git status etc.), output captured as evidence | local process | execute read-only commands | worker subprocess | Write/destructive commands blocked in adapter; budgets/timeouts enforced | **VERIFIED** (2026-10-21) |
| **Claude Code** | coding agent runs (intended) | vendor login (to verify) | filesystem + terminal in isolated worktree | CLI (planned adapter) | Not installed/verified here. Provider status `unverified`/`unavailable`; runs fail explicitly rather than fake success | **UNVERIFIED** |
| **OpenAI Codex CLI** | coding agent runs (intended) | API key / login (to verify) | filesystem + terminal in isolated worktree | CLI (planned adapter) | Same as above | **UNVERIFIED** |
| **Arena AI** | agent orchestration (intended) | API credentials (to verify) | documented API scope (TBD) | API (stub) | Interface not documented/confirmed; adapter refuses execution | **UNKNOWN** |
| **Freebuf** | unknown — identity to be confirmed by owner | unknown | unknown | unknown | Per issue #1: "Confirm what Freebuf refers to before implementing its adapter." Registry entry exists but **disabled** with `UNKNOWN IDENTITY` note | **UNKNOWN** |
| **Local model (Ollama-style)** | offline completions (intended) | none (local) | local network | HTTP localhost | No model server detected; checked at runtime (port 11434) | **UNAVAILABLE** |
| **HTTP API model (generic)** | structured completions (intended) | API key in OS-protected store | per provider | HTTPS | Cost/usage shown only if the provider API exposes it | **UNVERIFIED** |
| **Biza Miz support / bug API** | ingestion of bug reports, tickets, install/update failures | authenticated API/webhook (to confirm) | read support data; tenant-scoped | API/webhook (preferred) or isolated browser adapter | No verified endpoint from this environment; manual intake active. Direct production DB access explicitly out of scope | **UNAVAILABLE** (manual intake fallback **VERIFIED**) |
| **Windows Credential Manager** | secret storage | OS account | user scope | OS API | Not testable in this Linux sandbox; design keeps all secrets out of SQLite | **PLANNED** |
| **Tauri desktop shell** | packaging the UI as a Windows app | n/a | WebView2 (Win 10/11) | Tauri build | Requires Rust toolchain on the build machine; no Rust here | **PLANNED** |
| **Browser automation adapter** | last-resort UI automation where no API exists | explicit user login | browser profile of the user | isolated browser | Never bypasses authentication; consequential actions confirm-first | **PLANNED** (kept behind an adapter interface) |

## Status discipline (how "verified" is earned)

- A provider row flips to `verified` only after a real connection/execution check passes
  in the target environment (`POST /api/providers/:id/check`). Until then the UI shows
  `unverified`, `unknown`, or `unavailable` — never "ready".
- Cost/usage visibility is only claimed where the provider API exposes it.
- Sync/read failures mark the integration `unavailable` on the dashboard with the error
  text; they are never rendered as empty-but-healthy.

## Open verification items (from issue #1)

1. Inspect the existing app at `D:\Development\arena development managment` (owner-run checklist in discovery.md).
2. Confirm installed LLM tools and their supported execution/authentication interfaces.
3. Confirm what "Freebuf" refers to.
4. Confirm Biza Miz authenticated support/bug API or webhook availability + permissions.
5. Confirm minimum supported Windows versions and CPU architectures.
6. Re-check repository issues/PRs during each planning cycle to avoid duplicate tracking.
