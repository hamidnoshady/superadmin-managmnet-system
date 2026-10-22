/**
 * Redaction pipeline.
 *
 * Product principle: "Redact secrets and unnecessary personal/customer data
 * before sending support content to LLMs or GitHub."
 *
 * This module is the single gate for outbound content. It is intentionally
 * aggressive: a false positive (over-redaction) is safer than leaking a
 * credential or tenant identifier.
 */

export interface RedactionResult {
  redacted: string;
  findings: RedactionFinding[];
}

export interface RedactionFinding {
  kind:
    | 'github_token'
    | 'aws_key'
    | 'private_key'
    | 'bearer_token'
    | 'generic_secret'
    | 'password_assignment'
    | 'email'
    | 'ip_address'
    | 'connection_string'
    | 'slack_token'
    | 'openai_anthropic_key';
  count: number;
}

interface Rule {
  kind: RedactionFinding['kind'];
  pattern: RegExp;
  replace: string | ((match: string) => string);
}

const EMAIL_MASK = (email: string): string => {
  const [local, domain] = email.split('@');
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
};

const RULES: Rule[] = [
  {
    kind: 'private_key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '[REDACTED:PRIVATE_KEY]',
  },
  {
    kind: 'github_token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replace: '[REDACTED:GITHUB_TOKEN]',
  },
  {
    kind: 'aws_key',
    pattern: /\bAKIA[0-9A-Z]{16}\b|\b(?:ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    replace: '[REDACTED:AWS_KEY]',
  },
  {
    kind: 'slack_token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: '[REDACTED:SLACK_TOKEN]',
  },
  {
    kind: 'openai_anthropic_key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b|\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replace: '[REDACTED:API_KEY]',
  },
  {
    kind: 'bearer_token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
    replace: 'Bearer [REDACTED:TOKEN]',
  },
  {
    kind: 'connection_string',
    pattern: /\b(?:postgres|postgresql|mysql|mongodb|redis|sqlserver)(?:\+\w+)?:\/\/[^\s"']+/gi,
    replace: '[REDACTED:CONNECTION_STRING]',
  },
  {
    kind: 'password_assignment',
    pattern:
      /((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[=:]\s*)("[^"]+"|'[^']+'|[^\s,;&"']+)/gi,
    replace: '$1[REDACTED:SECRET]',
  },
  {
    kind: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: (m) => EMAIL_MASK(m),
  },
  {
    kind: 'ip_address',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replace: '[REDACTED:IP]',
  },
];

export function redact(input: string): RedactionResult {
  let redacted = input ?? '';
  const findings: RedactionFinding[] = [];

  for (const rule of RULES) {
    // Count matches first (on a copy), then replace with the raw replacer so
    // string replacements keep `$1` capture references intact.
    const count = redacted.match(rule.pattern)?.length ?? 0;
    if (typeof rule.replace === 'function') {
      redacted = redacted.replace(rule.pattern, rule.replace);
    } else {
      redacted = redacted.replace(rule.pattern, rule.replace);
    }
    if (count > 0) findings.push({ kind: rule.kind, count });
  }

  return { redacted, findings };
}

/**
 * Extra guard before any outbound LLM/LLM-adjacent call: throws when content
 * still matches a high-risk pattern after redaction (defense in depth).
 */
export function assertSafeForOutbound(text: string): void {
  const highRisk: Array<[RedactionFinding['kind'], RegExp]> = [
    ['github_token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
    ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['aws_key', /\bAKIA[0-9A-Z]{16}\b/],
  ];
  for (const [kind, pattern] of highRisk) {
    if (pattern.test(text)) {
      throw new Error(`Refusing outbound request: unredacted ${kind} detected`);
    }
  }
}
