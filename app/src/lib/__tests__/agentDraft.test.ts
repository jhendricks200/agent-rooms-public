import { describe, it, expect } from 'vitest';
import { parseAgentDraft, draftProse } from '../agentDraft';

// The promote gesture is the product. A draft the parser fails to
// recognize is a promote the user cannot perform, so recognition is
// deliberately generous about how the model fenced its output and whether
// it remembered the "Intent:" prefix.
describe('parseAgentDraft', () => {
  const structured = JSON.stringify({
    files: [
      { path: 'src/a.ts', content: 'export const a = 1;\n', changeType: 'add' },
      { path: 'src/b.ts', content: 'export const b = 2;\n', changeType: 'modify' },
    ],
  });

  it('parses the structured JSON shape the system prompt asks for', () => {
    const draft = parseAgentDraft(
      `Intent: add a and update b\n\n\`\`\`json\n${structured}\n\`\`\`\n\nRemix notes:\n- kept it small\n- no schema change`,
    );
    expect(draft).not.toBeNull();
    expect(draft!.format).toBe('structured');
    expect(draft!.intentSummary).toBe('add a and update b');
    expect(draft!.files).toEqual([
      { path: 'src/a.ts', changeType: 'add' },
      { path: 'src/b.ts', changeType: 'modify' },
    ]);
    expect(draft!.bullets).toEqual(['kept it small', 'no schema change']);
  });

  it('accepts a jsonc fence and an untagged fence', () => {
    expect(parseAgentDraft(`Intent: x\n\`\`\`jsonc\n${structured}\n\`\`\``)).not.toBeNull();
    expect(parseAgentDraft(`Intent: x\n\`\`\`\n${structured}\n\`\`\``)).not.toBeNull();
  });

  it('accepts a fenced unified diff and lists its files', () => {
    const diff = [
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1,1 @@',
      '+export const n = 1;',
    ].join('\n');
    const draft = parseAgentDraft(`Intent: add new\n\n\`\`\`diff\n${diff}\n\`\`\``);
    expect(draft).not.toBeNull();
    expect(draft!.format).toBe('unified-diff');
    expect(draft!.files).toEqual([{ path: 'src/new.ts', changeType: 'add' }]);
  });

  it('falls back to the first sentence when the model omits "Intent:"', () => {
    const draft = parseAgentDraft(`Adds a debounce to the search box. It also memoizes.\n\n\`\`\`json\n${structured}\n\`\`\``);
    expect(draft!.intentSummary).toBe('Adds a debounce to the search box.');
  });

  it('returns null for a reply with nothing promotable', () => {
    expect(parseAgentDraft('Here is how I would approach it, but I have not written code yet.')).toBeNull();
    expect(parseAgentDraft('```bash\nnpm test\n```')).toBeNull();
  });

  it('does not treat malformed JSON as a structured draft', () => {
    expect(parseAgentDraft('Intent: x\n```json\n{"files":[]}\n```')).toBeNull();
  });
});

describe('draftProse', () => {
  it('strips the fenced artifact so the card can stand in for it', () => {
    const prose = draftProse('Intent: do a thing\n\n```json\n{"files":[]}\n```\n\nRemix notes:\n- one');
    expect(prose).not.toContain('files');
    expect(prose).toContain('Intent: do a thing');
    expect(prose).toContain('Remix notes:');
  });
});
