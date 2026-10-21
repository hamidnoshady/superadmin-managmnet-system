# Windows packaging plan (Tauri) — PLANNED / UNTESTED

This environment has no Rust toolchain, so nothing here has been executed. It is the
agreed packaging direction from issue #1 and is deliberately marked untested.

## Target decision (needs owner confirmation)

| Question | Proposal | Impact |
|---|---|---|
| Minimum Windows version | Windows 10 1809+ (WebView2 evergreen) | older Windows needs WebView2 bootstrapper |
| Architectures | x64 first, arm64 second | separate Tauri targets per arch |
| Auto-update | Squirrel-style or Tauri updater, signed | requires code-signing cert |
| Secret storage | Windows Credential Manager via a small Rust command | keeps secrets out of SQLite entirely |

## Layout

```
apps/ui/            # existing React UI (unchanged)
apps/ui/src-tauri/  # Tauri shell (to be generated: npm create tauri-app)
  tauri.conf.json   # bundle identifier, windows, updater
  src/main.rs       # window + sidecar supervision only
apps/worker/        # runs as a supervised sidecar process
```

Key property from the plan: **the UI must not be the only owner of a long-running agent
process.** The Tauri shell starts the worker as a sidecar (or the worker runs as a
Windows service / scheduled task) and the UI simply connects to it; restarts of the UI
never kill running agent state — the worker's SQLite record is the source of truth and
crash-recovery marks interrupted runs explicitly.

## Steps to implement on a Windows machine

1. Install Rust (stable, MSVC toolchain) + Node 22 + WebView2 runtime.
2. `npm run build -w @dcc/ui` → static assets.
3. Scaffold `src-tauri` with the Tauri CLI, point it at `apps/ui/dist`.
4. Add sidecar launch/monitor of `apps/worker` (Node portable or bundled).
5. Bind the Windows Credential Manager helper for `githubMode: token_env` style secrets.
6. Code-sign the MSI/NSIS bundle; configure the updater feed.
7. Verify: run the full test suite on Windows (`npm test`), then the packaging checklist:
   - UI starts and reaches the worker via loopback
   - worker survives UI close/reopen
   - interrupted runs recover
   - credentials never touch `.dcc/`

## What stays the same

Everything the UI and worker do today is platform-neutral. Packaging adds a shell and a
credential store — it does not change the domain model, API, or security invariants.
