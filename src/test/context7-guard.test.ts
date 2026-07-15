import { describe, expect, it } from 'vitest';
import { ToolManager } from '../tool-manager';

/**
 * Context7 MCP Guardrail Tests
 *
 * Validates that the Context7 MCP server integration only processes
 * coding/SWE/developer-related queries and rejects everything else.
 *
 * NOTE: These tests exercise the guard logic *before* the actual MCP call
 * is made, so they don't need a running Context7 server. Non-dev queries
 * get short-circuited by the guard; dev queries will hit MCPManager.callMcpTool
 * which returns an error because Context7 isn't connected in the test env —
 * but the important thing is that they are NOT blocked by the guard.
 */

const GUARD_PREFIX = '[DocServer Guard]';

describe('Documentation MCP Guardrail (Context7)', () => {

  // ─── Allowed: Coding / Dev queries should pass through the guard ───

  describe('allows coding/dev-related queries', () => {
    const devQueries = [
      { desc: 'React library lookup', args: { libraryName: 'react' } },
      { desc: 'Express framework', args: { libraryName: 'express' } },
      { desc: 'TypeScript docs', args: { query: 'typescript generics' } },
      { desc: 'API reference', args: { query: 'api authentication best practices' } },
      { desc: 'Docker setup', args: { query: 'docker compose configuration' } },
      { desc: 'Database migration', args: { query: 'postgres database migration schema' } },
      { desc: 'NPM package', args: { libraryName: 'npm install webpack' } },
      { desc: 'Python framework', args: { query: 'django rest framework setup' } },
      { desc: 'CSS framework', args: { query: 'tailwind css responsive design' } },
      { desc: 'Testing tool', args: { query: 'vitest unit testing react components' } },
      { desc: 'DevDocs source', args: { query: 'devdocs react hooks' } },
      { desc: 'GitHub repo', args: { query: 'github open-source library' } },
      { desc: 'MDN reference', args: { query: 'mdn javascript fetch api' } },
      { desc: 'Cloud platform', args: { query: 'aws lambda serverless deploy' } },
      { desc: 'Auth library', args: { query: 'oauth jwt session middleware' } },
      { desc: 'Frontend framework', args: { query: 'next svelte remix frontend ssr' } },
      { desc: 'Build tool', args: { query: 'webpack vite bundler compiler' } },
      { desc: 'ORM query', args: { query: 'prisma orm crud query' } },
      { desc: 'Monitoring', args: { query: 'sentry datadog error monitoring' } },
      { desc: 'CI/CD pipeline', args: { query: 'ci cd pipeline deploy' } },
    ];

    for (const { desc, args } of devQueries) {
      it(`passes through for Context7: ${desc}`, async () => {
        const result = await ToolManager.execute('mcp__Context7__resolve-library-id', args);
        expect(result).not.toContain(GUARD_PREFIX);
      });
    }
  });

  // ─── Blocked: Non-dev queries should be rejected by the guard ───

  describe('blocks non-coding/non-dev queries', () => {
    const nonDevQueries = [
      { desc: 'cooking recipe', args: { query: 'how to bake a chocolate cake' } },
      { desc: 'weather forecast', args: { query: 'weather forecast tomorrow new york' } },
      { desc: 'sports scores', args: { query: 'nba basketball scores last night' } },
      { desc: 'movie reviews', args: { query: 'best movies of 2025 ratings' } },
      { desc: 'travel planning', args: { query: 'cheap flights to paris hotels' } },
      { desc: 'health advice', args: { query: 'symptoms of common cold treatment' } },
      { desc: 'stock market', args: { query: 'stock price prediction tesla' } },
      { desc: 'music lyrics', args: { query: 'taylor swift song lyrics album' } },
      { desc: 'fashion trends', args: { query: 'summer fashion trends outfits 2025' } },
      { desc: 'pet care', args: { query: 'how to train a puppy obedience' } },
    ];

    for (const { desc, args } of nonDevQueries) {
      it(`blocks Context7: ${desc}`, async () => {
        const result = await ToolManager.execute('mcp__Context7__resolve-library-id', args);
        expect(result).toContain(GUARD_PREFIX);
        expect(result).toContain('restricted to coding');
      });
    }
  });

  // ─── Edge cases ───

  describe('edge cases', () => {
    it('allows empty query (server-side will handle) for Context7', async () => {
      const result = await ToolManager.execute('mcp__Context7__resolve-library-id', {});
      expect(result).not.toContain(GUARD_PREFIX);
    });

    it('allows empty string query', async () => {
      const result = await ToolManager.execute('mcp__Context7__resolve-library-id', { query: '' });
      expect(result).not.toContain(GUARD_PREFIX);
    });

    it('guard applies to query-docs tool as well', async () => {
      const result = await ToolManager.execute('mcp__Context7__query-docs', {
        query: 'best vacation spots in hawaii beaches'
      });
      expect(result).toContain(GUARD_PREFIX);
    });

    it('guard does NOT apply to non-docs MCP servers', async () => {
      const result = await ToolManager.execute('mcp__Memory__create_entities', {
        query: 'how to bake a cake'
      });
      expect(result).not.toContain(GUARD_PREFIX);
    });

    it('case-insensitive keyword matching', async () => {
      const result = await ToolManager.execute('mcp__Context7__resolve-library-id', {
        query: 'REACT TYPESCRIPT NEXTJS'
      });
      expect(result).not.toContain(GUARD_PREFIX);
    });

    it('mixed dev + non-dev content passes', async () => {
      const result = await ToolManager.execute('mcp__Context7__resolve-library-id', {
        query: 'how to cook pasta with python'
      });
      expect(result).not.toContain(GUARD_PREFIX);
    });
  });
});
