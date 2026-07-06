import { describe, expect, it } from 'vitest';
import { isToolAllowedForSubagent } from '../subagents/registry';

describe('subagent tool allow-list', () => {
  it('allows core workspace tools for the general builder', () => {
    expect(isToolAllowedForSubagent('general-builder', 'read_file')).toBe(true);
    expect(isToolAllowedForSubagent('general-builder', 'write_file')).toBe(true);
    expect(isToolAllowedForSubagent('general-builder', 'switch_subagent')).toBe(true);
  });

  it('allows MCP tools via wildcard matching', () => {
    expect(isToolAllowedForSubagent('frontend-designer', 'mcp__Context7__query-docs')).toBe(true);
  });

  it('rejects obviously stale tool names', () => {
    expect(isToolAllowedForSubagent('test-writer', 'multi_edit_file')).toBe(false);
    expect(isToolAllowedForSubagent('backend-architect', 'ask_user')).toBe(false);
    expect(isToolAllowedForSubagent('security-reviewer', 'git_push')).toBe(false);
  });
});
