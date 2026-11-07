// OS-protected secret storage for the desktop shell.
//
// Windows: Credential Manager (CredWriteW/CredReadW) with a "dcc-" target
// prefix. Non-Windows builds report the backend as unavailable — the worker's
// env/locked-file backends cover those hosts (see apps/worker/src/services/secrets.ts).
//
// STATUS: the Windows path is implemented per the Win32 credential API but has
// NOT been executed on a Windows host from this sandbox. It is marked
// unverified until smoke-tested there. Secret values are never logged.

use serde::Serialize;

#[derive(Serialize)]
pub struct SecretStatus {
    pub backend: &'static str,
    pub available: bool,
    pub notes: &'static str,
}

#[derive(Serialize)]
pub struct SecretOutcome {
    pub ok: bool,
    pub value: Option<String>,
    pub error: Option<String>,
}

const TARGET_PREFIX: &str = "dcc-";

pub fn status() -> SecretStatus {
    #[cfg(windows)]
    {
        SecretStatus {
            backend: "windows_credential_manager",
            available: true,
            notes: "Credential Manager via CredWriteW/CredReadW (target prefix \"dcc-\"). Implemented but UNVERIFIED until smoke-tested on the target Windows host.",
        }
    }
    #[cfg(not(windows))]
    {
        SecretStatus {
            backend: "unavailable",
            available: false,
            notes: "Desktop secret backend is Windows-only in this scaffold. Use the worker's env/locked-file secret store on this OS.",
        }
    }
}

#[cfg(windows)]
pub fn set(name: &str, value: &str) -> SecretOutcome {
    use std::iter::once;
    use windows::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_TYPE_GENERIC, CRED_PERSIST_LOCAL_MACHINE,
    };

    let target: Vec<u16> = format!("{}{}", TARGET_PREFIX, name)
        .encode_utf16()
        .chain(once(0))
        .collect();
    let secret: Vec<u16> = value.encode_utf16().chain(once(0)).collect();

    let mut cred = CREDENTIALW::default();
    cred.Type = CRED_TYPE_GENERIC;
    cred.TargetName = windows::core::PWSTR(target.as_ptr() as *mut _);
    cred.CredentialBlob = secret.as_ptr() as *mut u8;
    cred.CredentialBlobSize = (secret.len() * 2) as u32; // bytes (UTF-16)
    cred.Persist = CRED_PERSIST_LOCAL_MACHINE;

    match unsafe { CredWriteW(&cred, 0) } {
        Ok(()) => SecretOutcome { ok: true, value: None, error: None },
        Err(err) => SecretOutcome { ok: false, value: None, error: Some(err.to_string()) },
    }
}

#[cfg(windows)]
pub fn get(name: &str) -> SecretOutcome {
    use std::slice::from_raw_parts;
    use windows::Win32::Security::Credentials::{CredReadW, CredFree, CREDENTIALW, CRED_TYPE_GENERIC};

    let target: Vec<u16> = format!("{}{}", TARGET_PREFIX, name)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let mut raw: *mut CREDENTIALW = std::ptr::null_mut();
    let ok = unsafe { CredReadW(windows::core::PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, 0, &mut raw) };
    if ok.is_err() || raw.is_null() {
        return SecretOutcome { ok: false, value: None, error: Some("secret not found".into()) };
    }
    let value = unsafe {
        let cred = &*raw;
        let blob = from_raw_parts(cred.CredentialBlob as *const u16, (cred.CredentialBlobSize / 2) as usize);
        let s = String::from_utf16_lossy(blob);
        CredFree(raw as *const _);
        s
    };
    SecretOutcome { ok: true, value: Some(value), error: None }
}

#[cfg(not(windows))]
pub fn set(_name: &str, _value: &str) -> SecretOutcome {
    SecretOutcome {
        ok: false,
        value: None,
        error: Some("OS secret backend is Windows-only in this scaffold — use the worker's env secret store.".into()),
    }
}

#[cfg(not(windows))]
pub fn get(_name: &str) -> SecretOutcome {
    SecretOutcome {
        ok: false,
        value: None,
        error: Some("OS secret backend is Windows-only in this scaffold — use the worker's env secret store.".into()),
    }
}
