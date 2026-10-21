import { describe, expect, it } from 'vitest';
import { redact, assertSafeForOutbound } from '../src/redaction.js';

describe('redaction', () => {
  it('redacts GitHub tokens', () => {
    const { redacted, findings } = redact('key ghp_abcdefghijklmnopqrstuvwxyz123456 leaked');
    expect(redacted).not.toContain('ghp_');
    expect(redacted).toContain('[REDACTED:GITHUB_TOKEN]');
    expect(findings.map((f) => f.kind)).toContain('github_token');
  });

  it('redacts github_pat fine-grained tokens', () => {
    const { redacted } = redact('github_pat_11AAAAAAA_abcdefghijklmnopqrstuvwxyz012345');
    expect(redacted).not.toContain('github_pat_');
  });

  it('redacts AWS keys', () => {
    const { redacted } = redact('access key AKIAIOSFODNN7EXAMPLE here');
    expect(redacted).toContain('[REDACTED:AWS_KEY]');
  });

  it('redacts private key blocks entirely', () => {
    const input = 'before\n-----BEGIN RSA PRIVATE KEY-----\nabc123\n-----END RSA PRIVATE KEY-----\nafter';
    const { redacted } = redact(input);
    expect(redacted).not.toContain('abc123');
    expect(redacted).toContain('[REDACTED:PRIVATE_KEY]');
  });

  it('redacts password/key assignments but keeps the key name', () => {
    const { redacted } = redact('password=hunter2 and api_key: "sk-abc" done');
    expect(redacted).toContain('password=[REDACTED:SECRET]');
    expect(redacted).not.toContain('hunter2');
  });

  it('masks emails but keeps deliverability context', () => {
    const { redacted } = redact('contact bob.smith@example.com please');
    expect(redacted).not.toContain('bob.smith');
    expect(redacted).toContain('@example.com');
  });

  it('redacts bearer tokens and connection strings', () => {
    const { redacted } = redact('Authorization: Bearer abcdefghijklmnop123456 url postgres://user:pass@db.host/app');
    expect(redacted).not.toContain('abcdefghijklmnop123456');
    expect(redacted).toContain('[REDACTED:CONNECTION_STRING]');
  });

  it('redacts IP addresses', () => {
    const { redacted } = redact('server 10.11.12.13 refused connection');
    expect(redacted).toContain('[REDACTED:IP]');
  });

  it('leaves clean text untouched', () => {
    const text = 'Installation failed on Windows 11 with error code 0x80070005 during update.';
    const { redacted, findings } = redact(text);
    expect(redacted).toBe(text);
    expect(findings).toHaveLength(0);
  });

  it('assertSafeForOutbound blocks leftover high-risk secrets', () => {
    expect(() => assertSafeForOutbound('all clear')).not.toThrow();
    expect(() => assertSafeForOutbound('ghp_abcdefghijklmnopqrstuvwxyz123456')).toThrow(/unredacted/);
    expect(() => assertSafeForOutbound('-----BEGIN PRIVATE KEY-----')).toThrow();
  });
});
