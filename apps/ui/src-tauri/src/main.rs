// Development Command Center — desktop shell (Tauri 2).
//
// STATUS: scaffold. Not compiled/tested in the development sandbox (no Rust
// toolchain and no Windows host available there). The shell exposes exactly
// one capability the web stack cannot provide on Windows: OS-protected secret
// storage via the Credential Manager. All product logic stays in the local
// worker (@dcc/worker) — this process never talks to GitHub, LLMs, or Biza
// Miz itself.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod secret_store;

use secret_store::{SecretOutcome, SecretStatus};

/// Report how secrets are stored on this host. Never returns secret values.
#[tauri::command]
fn dcc_secret_status() -> SecretStatus {
    secret_store::status()
}

/// Store a secret by NAME in OS-protected storage. The value is never logged.
#[tauri::command]
fn dcc_secret_set(name: String, value: String) -> SecretOutcome {
    secret_store::set(&name, &value)
}

/// Read a secret by name (only for the local worker through the UI).
#[tauri::command]
fn dcc_secret_get(name: String) -> SecretOutcome {
    secret_store::get(&name)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            dcc_secret_status,
            dcc_secret_set,
            dcc_secret_get
        ])
        .run(tauri::generate_context!())
        .expect("error while running Development Command Center desktop shell");
}
