/**
 * secret-scanner.ts — Regex-based secret scanner for pre-extraction redaction.
 * Strips API keys, passwords, tokens, private keys, and connection strings
 * before any text reaches LLM endpoints.
 */

const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi,
    label: "api_key",
  },
  {
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
    label: "password",
  },
  {
    pattern: /(?:token|secret)\s*[:=]\s*['"]?([a-zA-Z0-9_\-\.]{20,})['"]?/gi,
    label: "token",
  },
  {
    pattern: /(?:authorization\s*:\s*)?bearer\s+[a-zA-Z0-9._\-]{20,}/gi,
    label: "bearer_token",
  },
  {
    pattern: /\beyJ[a-zA-Z0-9_\-]+?\.[a-zA-Z0-9_\-]+?\.[a-zA-Z0-9_\-]+/g,
    label: "jwt",
  },
  {
    pattern: /(?:session(?:id)?|cookie|refresh[_-]?token)\s*[:=]\s*['"]?([^\s'";]{16,})['"]?/gi,
    label: "session_secret",
  },
  {
    pattern: /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/g,
    label: "private_key",
  },
  {
    pattern: /(?:postgresql|mysql|mongodb|redis):\/\/[^\s]+/gi,
    label: "connection_string",
  },
  {
    pattern: /(?:sk-|pk_live_|pk_test_|sk_live_|sk_test_|ghp_|gho_|github_pat_|xox[baprs]-|ya29\.|hf_[A-Za-z0-9]{20,}|glpat-|sg\.[A-Za-z0-9._-]{20,})[a-zA-Z0-9_\-\.]{10,}/g,
    label: "vendor_key",
  },
  {
    pattern: /(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key)\s*[:=]\s*['"]?([a-zA-Z0-9/+=]{30,})['"]?/gi,
    label: "aws_secret",
  },
];

export interface RedactionResult {
  redacted: string;
  secretsFound: number;
  labels: string[];
}

export function redactSecrets(text: string): RedactionResult {
  let redacted = text;
  let secretsFound = 0;
  const labels: string[] = [];

  for (const { pattern, label } of SECRET_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    const matches = redacted.match(pattern);
    if (matches) {
      secretsFound += matches.length;
      if (!labels.includes(label)) labels.push(label);
      redacted = redacted.replace(pattern, `[REDACTED:${label}]`);
    }
    // Reset again after replace (global regex state)
    pattern.lastIndex = 0;
  }

  return { redacted, secretsFound, labels };
}
