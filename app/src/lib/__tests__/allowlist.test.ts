import { afterEach, describe, expect, it } from 'vitest';
import { checkAllowlist } from '../allowlist';

const ENV = 'AGENT_ROOMS_ALLOWLIST';

afterEach(() => {
  delete process.env[ENV];
});

describe('checkAllowlist', () => {
  it('allows everyone when no allowlist is configured', () => {
    const d = checkAllowlist({ login: 'stranger', githubUserId: '999' });
    expect(d).toEqual({ allowed: true, reason: 'no-allowlist-configured' });
  });

  it('refuses everyone when the allowlist is present but empty', () => {
    process.env[ENV] = '';
    expect(checkAllowlist({ login: 'jhendricks200', githubUserId: '72288418' }).allowed).toBe(false);
  });

  it('matches on login case-insensitively and ignores surrounding whitespace', () => {
    process.env[ENV] = ' JHendricks200 , mara ';
    expect(checkAllowlist({ login: 'jhendricks200', githubUserId: '72288418' }).allowed).toBe(true);
    expect(checkAllowlist({ login: 'MARA', githubUserId: '5' }).allowed).toBe(true);
  });

  it('matches on the numeric github id', () => {
    process.env[ENV] = '72288418';
    expect(checkAllowlist({ login: 'renamed-since', githubUserId: '72288418' }).allowed).toBe(true);
  });

  it('refuses an account on neither list', () => {
    process.env[ENV] = 'jhendricks200,72288418';
    const d = checkAllowlist({ login: 'stranger', githubUserId: '999' });
    expect(d).toEqual({ allowed: false, reason: 'not-on-allowlist' });
  });

  it('does not treat an empty login or id as a match against empty entries', () => {
    process.env[ENV] = 'jhendricks200';
    expect(checkAllowlist({ login: '', githubUserId: '' }).allowed).toBe(false);
  });
});
