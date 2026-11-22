import { describe, it, expect } from 'vitest';
import { scanForSecrets } from '@/lib/secretScan';

// All fixture values below are obviously fake / structurally-shaped
// placeholders, not real credentials.
describe('scanForSecrets', () => {
  it('is clean on ordinary diff text', () => {
    const result = scanForSecrets('export function add(a: number, b: number) { return a + b; }');
    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it('flags an AWS access key id', () => {
    const result = scanForSecrets('const key = "AKIAABCDEFGHIJKLMNOP";');
    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.pattern === 'aws-access-key-id')).toBe(true);
  });

  // Fixtures in this file are made up. Some are joined from two pieces so that
  // hosted secret scanners do not mistake them for live credentials; the
  // scanner under test still receives the full string.
  it('flags a GCP API key', () => {
    const result = scanForSecrets('GOOGLE_API_KEY=AIza' + '0123456789abcdefghijklmnopqrstuvwxy');
    expect(result.findings.some((f) => f.pattern === 'gcp-api-key')).toBe(true);
  });

  it('flags a GitHub personal access token (ghp_)', () => {
    const result = scanForSecrets('token: ghp_1234567890abcdefghijklmnopqrstuvwxyz');
    expect(result.findings.some((f) => f.pattern === 'github-personal-token')).toBe(true);
  });

  it('flags a GitHub fine-grained PAT (github_pat_)', () => {
    const result = scanForSecrets('github_pat_11ABCDEFG0123456789abcdefghijklmnopqrstuvwxyz');
    expect(result.findings.some((f) => f.pattern === 'github-fine-grained-pat')).toBe(true);
  });

  it('flags an OpenAI-shaped key (sk-)', () => {
    const result = scanForSecrets('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN');
    expect(result.findings.some((f) => f.pattern === 'openai-key')).toBe(true);
  });

  it('flags an Anthropic-shaped key (sk-ant-)', () => {
    const result = scanForSecrets('ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(result.findings.some((f) => f.pattern === 'anthropic-key')).toBe(true);
  });

  it('flags an OpenRouter-shaped key (sk-or-)', () => {
    const result = scanForSecrets('OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(result.findings.some((f) => f.pattern === 'openrouter-key')).toBe(true);
  });

  it('flags a Slack bot token', () => {
    const result = scanForSecrets('xoxb-' + '000000000000-000000000000-abcdefghijklmnopqrstuvwx');
    expect(result.findings.some((f) => f.pattern === 'slack-token')).toBe(true);
  });

  it('flags a Slack incoming webhook URL', () => {
    const result = scanForSecrets('https://hooks.slack.com/' + 'services/T00000000/B00000000/abcdefghijklmnopqrstuvwx');
    expect(result.findings.some((f) => f.pattern === 'slack-webhook')).toBe(true);
  });

  it('flags a Stripe live secret key', () => {
    const result = scanForSecrets('sk_live_' + 'abcdefghijklmnopqrstuvwx');
    expect(result.findings.some((f) => f.pattern === 'stripe-live-key')).toBe(true);
  });

  it('flags a PEM private key block', () => {
    const result = scanForSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEFAKEFAKE\n-----END RSA PRIVATE KEY-----');
    expect(result.findings.some((f) => f.pattern === 'private-key-block')).toBe(true);
  });

  it('flags a generic high-entropy credential assignment', () => {
    const result = scanForSecrets('client_secret: "sup3rSecretValue1234567890abcdef"');
    expect(result.findings.some((f) => f.pattern === 'generic-credential-assignment')).toBe(true);
  });

  it('deduplicates the same finding seen more than once', () => {
    const dupe = 'AKIAABCDEFGHIJKLMNOP appears twice: AKIAABCDEFGHIJKLMNOP';
    const result = scanForSecrets(dupe);
    expect(result.findings.filter((f) => f.pattern === 'aws-access-key-id')).toHaveLength(1);
  });

  it('runs across the diff and remix note bullets joined together, matching promote\'s usage', () => {
    const diff = 'export const ok = true;';
    const bullets = ['normal bullet', 'oops left in: ghp_1234567890abcdefghijklmnopqrstuvwxyz'];
    const result = scanForSecrets([diff, ...bullets].join('\n'));
    expect(result.clean).toBe(false);
  });
});
