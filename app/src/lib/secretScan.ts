// Secret scanning, run on every promote across the diff and the remix note
// bullets before publish (design doc, Safety mechanics item 1: "Secret
// scanning runs on every promote... with an exact publish preview shown to
// the promoter"). Findings block publish outright; they are never
// published-then-redacted.
//
// This is a dependency-free regex table, not a byte-for-byte replacement
// for gitleaks/trufflehog, but it covers the credential shapes most likely
// to leak from an agent draft: cloud provider keys, common SaaS API
// tokens, private-key blocks, and generic high-entropy assignments.

export interface SecretFinding {
  pattern: string;
  match: string;
}

export interface SecretScanResult {
  clean: boolean;
  findings: SecretFinding[];
}

const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  // AWS
  { name: 'aws-access-key-id', regex: /\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'aws-secret-access-key', regex: /(?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
  // GCP
  { name: 'gcp-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'gcp-service-account', regex: /"type"\s*:\s*"service_account"/g },
  // GitHub
  { name: 'github-personal-token', regex: /\bghp_[A-Za-z0-9]{36}\b/g },
  { name: 'github-fine-grained-pat', regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { name: 'github-oauth-token', regex: /\bgho_[A-Za-z0-9]{36}\b/g },
  { name: 'github-app-token', regex: /\b(ghu|ghs)_[A-Za-z0-9]{36}\b/g },
  // Model providers
  { name: 'openai-key', regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: 'anthropic-key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'openrouter-key', regex: /\bsk-or-[A-Za-z0-9_-]{20,}\b/g },
  // Slack
  { name: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'slack-webhook', regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g },
  // Stripe
  { name: 'stripe-live-key', regex: /\b(sk|rk)_live_[A-Za-z0-9]{16,}\b/g },
  { name: 'stripe-test-key', regex: /\b(sk|rk)_test_[A-Za-z0-9]{16,}\b/g },
  // Private key material
  { name: 'private-key-block', regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  // Generic high-entropy credential assignments (api key / secret / token /
  // password style fields with a long quoted value). Kept as a catch-all,
  // last, so the more specific patterns above get to name themselves first.
  {
    name: 'generic-credential-assignment',
    regex: /(?:api[_-]?key|apikey|secret|token|password|passwd|client[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9_\-/+=]{16,}['"]/gi,
  },
];

/**
 * Scans arbitrary text (diff content or remix note text) for secret-shaped
 * strings. Deduplicates identical (pattern, match) pairs so one leaked
 * credential appearing on multiple diff lines is reported once per shape,
 * not once per occurrence.
 */
export function scanForSecrets(text: string): SecretScanResult {
  const seen = new Set<string>();
  const findings: SecretFinding[] = [];

  for (const { name, regex } of PATTERNS) {
    const matches = text.match(regex) ?? [];
    for (const match of matches) {
      const key = `${name}::${match}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ pattern: name, match });
    }
  }

  return { clean: findings.length === 0, findings };
}
