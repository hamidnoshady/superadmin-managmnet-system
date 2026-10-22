import { redact, assertSafeForOutbound } from '@dcc/core';
import type { SecretStore } from './secrets.js';

export type LlmStyle = 'openai' | 'ollama';

export interface LlmProviderConfig {
  /** e.g. https://api.openai.com or http://127.0.0.1:11434 */
  baseUrl: string;
  model: string;
  /** Name of the env/secret holding the API key (never the key itself). */
  apiKeyEnv: string;
  style: LlmStyle;
}

export interface LlmUsage {
  usedLlm: boolean;
  provider: string;
  model: string | null;
  note: string;
}

export type LlmResult = ({ ok: true; text: string } | { ok: false; error: string }) & LlmUsage;

/**
 * LLM client for API and local-model providers (OpenAI-compatible chat
 * completions and Ollama-style generate).
 *
 * Outbound discipline (product principles):
 *  - prompts are redacted before leaving the machine
 *  - `assertSafeForOutbound` refuses leftover high-risk secrets
 *  - untrusted content must arrive pre-fenced (core.wrapUntrusted)
 *  - every call reports `usedLlm` honestly; failures never look like success
 */
export class LlmClient {
  constructor(
    private readonly config: LlmProviderConfig,
    private readonly secrets: SecretStore,
    private readonly providerLabel: string,
  ) {}

  async complete(system: string, user: string, opts: { maxTokens?: number; temperature?: number } = {}): Promise<LlmResult> {
    const base = this.config.baseUrl.replace(/\/$/, '');
    const outgoing = redact(`${system}\n\n${user}`).redacted;
    try {
      assertSafeForOutbound(outgoing);
    } catch (err) {
      return {
        ok: false, error: err instanceof Error ? err.message : String(err),
        usedLlm: false, provider: this.providerLabel, model: this.config.model,
        note: 'Outbound prompt refused by secret gate — nothing was sent.',
      };
    }

    try {
      const res = this.config.style === 'ollama'
        ? await this.ollama(base, outgoing, opts)
        : await this.openai(base, outgoing, opts);
      return res;
    } catch (err) {
      return {
        ok: false, error: err instanceof Error ? err.message : String(err),
        usedLlm: false, provider: this.providerLabel, model: this.config.model,
        note: 'LLM request failed — recorded as failure, not as output.',
      };
    }
  }

  private async openai(base: string, prompt: string, opts: { maxTokens?: number; temperature?: number }): Promise<LlmResult> {
    const apiKey = this.config.apiKeyEnv ? await this.secrets.resolveEnvRef(this.config.apiKeyEnv) : null;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.2,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return {
        ok: false, error: `HTTP ${res.status}`,
        usedLlm: false, provider: this.providerLabel, model: this.config.model,
        note: 'Provider rejected the request.',
      };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? '';
    return {
      ok: true, text,
      usedLlm: true, provider: this.providerLabel, model: this.config.model,
      note: 'Response produced by the configured LLM provider.',
    };
  }

  private async ollama(base: string, prompt: string, opts: { maxTokens?: number }): Promise<LlmResult> {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, prompt, stream: false, options: { num_predict: opts.maxTokens ?? 1024 } }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      return {
        ok: false, error: `HTTP ${res.status}`,
        usedLlm: false, provider: this.providerLabel, model: this.config.model,
        note: 'Local model server rejected the request.',
      };
    }
    const data = (await res.json()) as { response?: string };
    return {
      ok: true, text: data.response ?? '',
      usedLlm: true, provider: this.providerLabel, model: this.config.model,
      note: 'Response produced by the local model server.',
    };
  }

  /** JSON-mode helper: strips code fences and parses conservatively. */
  async completeJson<T>(system: string, user: string): Promise<LlmResult & { parsed?: T }> {
    const result = await this.complete(`${system}\nRespond with a single JSON object only.`, user);
    if (!result.ok) return result;
    const match = result.text.match(/\{[\s\S]*\}/);
    if (!match) {
      return { ...result, ok: false, error: 'No JSON object in LLM response', note: result.note };
    }
    try {
      return { ...result, parsed: JSON.parse(match[0]) as T };
    } catch {
      return { ...result, ok: false, error: 'LLM returned invalid JSON', note: result.note };
    }
  }
}

export function styleFor(baseUrl: string): LlmStyle {
  return /11434|ollama/i.test(baseUrl) ? 'ollama' : 'openai';
}
