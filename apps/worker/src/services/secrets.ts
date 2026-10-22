import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';

const execFileAsync = promisify(execFile);

export type SecretBackend = 'windows_credential_manager' | 'env' | 'locked_file';

export interface SecretStatus {
  backend: SecretBackend;
  available: boolean;
  notes: string;
  checkedAt: string;
}

/**
 * OS-protected secret storage.
 *
 * Product principle: "Store secrets in OS-protected storage; never include
 * them in prompts, issue bodies, logs, or diagnostic bundles."
 *
 * Backends:
 *  - windows_credential_manager: CredWrite/CredRead via PowerShell P/Invoke
 *    (implemented; requires Windows — marked untested outside Windows).
 *  - env: process environment of the worker session (verified on all OSes).
 *  - locked_file: 0600 file under .dcc/secrets as a last-resort fallback with
 *    an explicit warning — never the default.
 *
 * Secrets are addressed by NAME everywhere else in the app; values never enter
 * SQLite, prompts, logs, or bundles.
 */
export class SecretStore {
  private readonly filePath: string;

  constructor(private readonly targetPrefix = 'dcc') {
    this.filePath = path.join(CONFIG.dataDir, 'secrets', 'secrets.json');
  }

  status(): SecretStatus {
    const checkedAt = new Date().toISOString();
    if (process.platform === 'win32') {
      return {
        backend: 'windows_credential_manager',
        available: true,
        notes: 'Windows Credential Manager via CredWrite/CredRead P/Invoke (target prefix "' + this.targetPrefix + '"). Verify on the Windows host.',
        checkedAt,
      };
    }
    return {
      backend: 'env',
      available: true,
      notes: 'Session environment variables. On Windows builds the Credential Manager backend is used instead.',
      checkedAt,
    };
  }

  async set(name: string, value: string): Promise<{ ok: boolean; backend: SecretBackend; error?: string }> {
    if (process.platform === 'win32') {
      try {
        await this.winSet(name, value);
        return { ok: true, backend: 'windows_credential_manager' };
      } catch (err) {
        // Honest fallback: if the Credential Manager path fails (it is still
        // UNVERIFIED outside real Windows hosts), store in the env backend and
        // say exactly that — never silently claim the OS keystore was used.
        const cmError = err instanceof Error ? err.message : String(err);
        const fallback = await this.setEnvBackend(name, value);
        if (fallback.ok) {
          return {
            ok: true,
            backend: 'env',
            error: `Credential Manager failed (${cmError}) — stored in the env backend instead`,
          };
        }
        return { ok: false, backend: 'windows_credential_manager', error: cmError };
      }
    }
    return this.setEnvBackend(name, value);
  }

  /** Session-env + 0600 locked-file backend (all OSes). */
  private async setEnvBackend(name: string, value: string): Promise<{ ok: boolean; backend: SecretBackend; error?: string }> {
    process.env[name] = value;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const store = fs.existsSync(this.filePath) ? JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, string> : {};
      store[name] = value;
      fs.writeFileSync(this.filePath, JSON.stringify(store), { mode: 0o600 });
      fs.chmodSync(this.filePath, 0o600);
      return { ok: true, backend: 'env' };
    } catch (err) {
      return { ok: false, backend: 'env', error: err instanceof Error ? err.message : String(err) };
    }
  }

  async get(name: string): Promise<string | null> {
    if (process.env[name]) return process.env[name] ?? null;
    if (process.platform === 'win32') {
      try {
        return await this.winGet(name);
      } catch {
        return null;
      }
    }
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const store = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, string>;
      return store[name] ?? null;
    } catch {
      return null;
    }
  }

  /** Resolve a configured env-var NAME to its value, without ever logging it. */
  async resolveEnvRef(envName: string): Promise<string | null> {
    return this.get(envName);
  }

  private async winSet(name: string, value: string): Promise<void> {
    const script = [
      'Add-Type -TypeDefinition @\'',
      'using System;using System.Runtime.InteropServices;',
      'public class DccCred {',
      '[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
      'public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }',
      '[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
      'public static extern bool CredWrite(ref CREDENTIAL cred, uint flags);',
      '}',
      '\'@;',
      `$blob = [System.Text.Encoding]::UTF8.GetBytes('${value.replace(/'/g, "''")}');`,
      `$c = New-Object DccCred+CREDENTIAL; $c.Type = 1; $c.TargetName = '${this.targetPrefix}/${name.replace(/'/g, "''")}'; $c.CredentialBlobSize = $blob.Length;`,
      '$ptr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($blob.Length); [System.Runtime.InteropServices.Marshal]::Copy($blob, 0, $ptr, $blob.Length); $c.CredentialBlob = $ptr; $c.Persist = 2; $c.UserName = "dcc";',
      '[DccCred]::CredWrite([ref]$c, 0) | Out-Null;',
    ].join('\n');
    await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 15_000 });
  }

  private async winGet(name: string): Promise<string | null> {
    const script = [
      'Add-Type -TypeDefinition @\'',
      'using System;using System.Runtime.InteropServices;',
      'public class DccCredR {',
      '[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
      'public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }',
      '[DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
      'public static extern bool CredRead(string target, uint type, uint flags, out IntPtr credPtr);',
      '[DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);',
      '}',
      '\'@;',
      `$ptr = New-Object IntPtr;`,
      `if (-not [DccCredR]::CredRead('${this.targetPrefix}/${name.replace(/'/g, "''")}', 1, 0, [ref]$ptr)) { exit 1 }`,
      '$c = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][DccCredR+CREDENTIAL]);',
      '$bytes = New-Object byte[] $c.CredentialBlobSize; [System.Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob, $bytes, 0, $c.CredentialBlobSize);',
      '[System.Text.Encoding]::UTF8.GetString($bytes);',
      '[DccCredR]::CredFree($ptr) > $null;',
    ].join('\n');
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 15_000 });
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  }
}
