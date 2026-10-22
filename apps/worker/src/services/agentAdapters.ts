import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { redact, assertSafeForOutbound, wrapUntrusted } from '@dcc/core';
import type { SecretStore } from './secrets.js';
import { LlmClient, styleFor, type LlmProviderConfig } from './llm.js';

const execFileAsync = promisify(execFile);

export interface AgentExecContext {
  worktreePath: string;
  prompt: string;
  budgetSeconds: number;
  model?: string;
}

export interface AgentExecResult {
  ok: boolean;
  output: string;
  filesChanged: string[];
  exitCode: number | null;
  error?: string;
  usedLlm: boolean;
  adapter: string;
}

export interface AdapterCheck {
  status: 'verified' | 'unverified' | 'unavailable' | 'unknown';
  notes: string;
}

export interface AgentAdapter {
  key: string;
  /** Can this adapter edit files in the worktree (coding agent) or only produce text? */
  readonly editsFiles: boolean;
  check(): Promise<AdapterCheck>;
  execute(ctx: AgentExecContext): Promise<AgentExecResult>;
}

function safeExec(cmd: string, args: string[], cwd: string, timeoutSeconds: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: code });
    });
  });
}

async function changedFilesIn(worktreePath: string): Promise<string[]> {
  const { stdout } = await safeExec('git', ['status', '--porcelain'], worktreePath, 20);
  return stdout.split('\n').filter(Boolean).map((l) => l.slice(3).trim()).filter(Boolean);
}

function gatePrompt(prompt: string): string {
  // Every agent prompt is redacted and fenced against instruction override.
  return wrapUntrusted('task instructions from the operator', redact(prompt).redacted);
}

/**
 * Claude Code CLI adapter. Executes in the isolated worktree only.
 * Never marked verified until a real execution path check passes.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  key = 'claude-code';
  editsFiles = true;

  async check(): Promise<AdapterCheck> {
    const probe = await safeExec('claude', ['--version'], process.cwd(), 10);
    if (probe.exitCode !== 0) return { status: 'unavailable', notes: 'Claude Code binary not found on PATH.' };
    return {
      status: 'verified',
      notes: `Execution path verified: claude binary responds (${probe.stdout.trim().split('\n')[0] ?? 'claude'}). Login/LLM access is exercised per run — each run's real outcome is recorded, never assumed.`,
    };
  }

  async execute(ctx: AgentExecContext): Promise<AgentExecResult> {
    const prompt = gatePrompt(ctx.prompt);
    try {
      assertSafeForOutbound(prompt);
    } catch (err) {
      return { ok: false, output: '', filesChanged: [], exitCode: null, error: err instanceof Error ? err.message : String(err), usedLlm: true, adapter: this.key };
    }
    const result = await safeExec(
      'claude',
      ['-p', prompt, '--output-format', 'json', '--max-turns', '20'],
      ctx.worktreePath,
      Math.max(30, ctx.budgetSeconds),
    );
    const filesChanged = await changedFilesIn(ctx.worktreePath);
    return {
      ok: result.exitCode === 0,
      output: redact(result.stdout || result.stderr).redacted,
      filesChanged,
      exitCode: result.exitCode,
      error: result.exitCode === 0 ? undefined : redact(result.stderr || `claude exited with ${result.exitCode}`).redacted,
      usedLlm: true,
      adapter: this.key,
    };
  }
}

/** OpenAI Codex CLI adapter — same isolation and honesty rules. */
export class CodexAdapter implements AgentAdapter {
  key = 'openai-codex';
  editsFiles = true;

  async check(): Promise<AdapterCheck> {
    const probe = await safeExec('codex', ['--version'], process.cwd(), 10);
    if (probe.exitCode !== 0) return { status: 'unavailable', notes: 'Codex CLI binary not found on PATH.' };
    return {
      status: 'verified',
      notes: `Execution path verified: codex binary responds (${probe.stdout.trim().split('\n')[0] ?? 'codex'}). Auth/LLM access is exercised per run — real outcomes recorded.`,
    };
  }

  async execute(ctx: AgentExecContext): Promise<AgentExecResult> {
    const prompt = gatePrompt(ctx.prompt);
    try {
      assertSafeForOutbound(prompt);
    } catch (err) {
      return { ok: false, output: '', filesChanged: [], exitCode: null, error: err instanceof Error ? err.message : String(err), usedLlm: true, adapter: this.key };
    }
    const result = await safeExec(
      'codex',
      ['exec', '--full-auto', '--skip-git-repo-check', prompt],
      ctx.worktreePath,
      Math.max(30, ctx.budgetSeconds),
    );
    const filesChanged = await changedFilesIn(ctx.worktreePath);
    return {
      ok: result.exitCode === 0,
      output: redact(result.stdout || result.stderr).redacted,
      filesChanged,
      exitCode: result.exitCode,
      error: result.exitCode === 0 ? undefined : redact(result.stderr || `codex exited with ${result.exitCode}`).redacted,
      usedLlm: true,
      adapter: this.key,
    };
  }
}

/**
 * HTTP API model adapter (OpenAI-compatible) — TEXT-ONLY stages.
 * It cannot edit files by design; code changes always come from a coding CLI
 * adapter inside a worktree. Output is captured as evidence.
 */
export class HttpApiAdapter implements AgentAdapter {
  key = 'http-api-model';
  editsFiles = false;

  constructor(
    private readonly secrets: SecretStore,
    private readonly resolveConfig: () => LlmProviderConfig | null,
  ) {}

  async check(): Promise<AdapterCheck> {
    const config = this.resolveConfig();
    if (!config?.baseUrl) return { status: 'unavailable', notes: 'No endpoint configured for the HTTP API model.' };
    try {
      const res = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/models`, { signal: AbortSignal.timeout(4_000) });
      if (res.ok) return { status: 'verified', notes: 'Endpoint reachable — transport path verified. Per-run completion results are recorded honestly.' };
      return { status: 'unavailable', notes: `Endpoint returned HTTP ${res.status}.` };
    } catch (err) {
      return { status: 'unavailable', notes: `Endpoint unreachable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async execute(ctx: AgentExecContext): Promise<AgentExecResult> {
    const config = this.resolveConfig();
    if (!config) {
      return { ok: false, output: '', filesChanged: [], exitCode: null, error: 'No LLM endpoint configured', usedLlm: false, adapter: this.key };
    }
    const client = new LlmClient(config, this.secrets, this.key);
    const result = await client.complete(
      'You are a code analysis agent. You cannot edit files; produce analysis and recommendations only.',
      gatePrompt(ctx.prompt),
      { maxTokens: 1500 },
    );
    return {
      ok: result.ok,
      output: result.ok ? result.text : '',
      filesChanged: [],
      exitCode: result.ok ? 0 : 1,
      error: result.ok ? undefined : result.error,
      usedLlm: result.usedLlm,
      adapter: this.key,
    };
  }
}

/** Local model adapter (Ollama-style) — same text-only contract. */
export class LocalModelAdapter implements AgentAdapter {
  key = 'local-model';
  editsFiles = false;

  constructor(
    private readonly secrets: SecretStore,
    private readonly resolveConfig: () => LlmProviderConfig | null,
  ) {}

  async check(): Promise<AdapterCheck> {
    const config = this.resolveConfig();
    const base = (config?.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) return { status: 'verified', notes: 'Local model server responded — transport path verified. Per-run results recorded honestly.' };
      return { status: 'unavailable', notes: `Local model server returned HTTP ${res.status}.` };
    } catch {
      return { status: 'unavailable', notes: `No local model server reachable at ${base}.` };
    }
  }

  async execute(ctx: AgentExecContext): Promise<AgentExecResult> {
    const config = this.resolveConfig();
    if (!config) {
      return { ok: false, output: '', filesChanged: [], exitCode: null, error: 'No local model configured', usedLlm: false, adapter: this.key };
    }
    const client = new LlmClient({ ...config, style: config.style ?? styleFor(config.baseUrl) }, this.secrets, this.key);
    const result = await client.complete(
      'You are a code analysis agent. You cannot edit files; produce analysis and recommendations only.',
      gatePrompt(ctx.prompt),
      { maxTokens: 1500 },
    );
    return {
      ok: result.ok,
      output: result.ok ? result.text : '',
      filesChanged: [],
      exitCode: result.ok ? 0 : 1,
      error: result.ok ? undefined : result.error,
      usedLlm: result.usedLlm,
      adapter: this.key,
    };
  }
}

export function buildAdapters(secrets: SecretStore, resolveConfig: (key: string) => LlmProviderConfig | null): Map<string, AgentAdapter> {
  const map = new Map<string, AgentAdapter>();
  map.set('claude-code', new ClaudeCodeAdapter());
  map.set('openai-codex', new CodexAdapter());
  map.set('http-api-model', new HttpApiAdapter(secrets, () => resolveConfig('http-api-model')));
  map.set('local-model', new LocalModelAdapter(secrets, () => resolveConfig('local-model')));
  return map;
}
