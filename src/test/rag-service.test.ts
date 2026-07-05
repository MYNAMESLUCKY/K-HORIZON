import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RAGService } from '../rag-service';
import { DBClient } from '../db-client';
import { workspace } from 'vscode';

describe('RAGService', () => {
  let mockPool: any;
  let mockClient: any;

  beforeEach(() => {
    // Reset the static memory cache between tests to avoid bleed-through
    (RAGService as any).memoryEmbeddingCache.clear();

    mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };

    mockPool = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      connect: vi.fn().mockResolvedValue(mockClient),
    };

    vi.spyOn(DBClient, 'initialize').mockResolvedValue(mockPool);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('chunkFile', () => {
    it('returns a single chunk for short content', () => {
      const chunks = RAGService.chunkFile('test.ts', 'const a = 1;');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toContain('File: test.ts');
      expect(chunks[0]).toContain('const a = 1;');
    });

    it('splits long content into multiple chunks with overlap', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
      const chunks = RAGService.chunkFile('test.ts', lines);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks[0]).toContain('Lines 1-35');
      // Second chunk should start around line 31 due to 5 lines of overlap (chunkSize 35 - overlap 5 = step 30)
      expect(chunks[1]).toContain('Lines 31-');
    });
  });

  describe('getEmbeddings', () => {
    it('uses memory cache first', async () => {
      const dummyEmbedding = new Array(1024).fill(0.1);
      const hash = (RAGService as any).hashContent('test input');
      (RAGService as any).memoryEmbeddingCache.set(hash, dummyEmbedding);

      const results = await RAGService.getEmbeddings(['test input']);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(dummyEmbedding);
      expect(DBClient.initialize).not.toHaveBeenCalled();
    });

    it('checks database cache if not in memory cache', async () => {
      const dummyEmbedding = new Array(1024).fill(0.2);
      mockPool.query.mockResolvedValueOnce({
        rows: [{ emb: `[${dummyEmbedding.join(',')}]` }]
      });

      const results = await RAGService.getEmbeddings(['test input']);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(dummyEmbedding);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT embedding::text AS emb FROM embedding_cache'),
        expect.any(Array)
      );
    });

    it('fetches from API credits when cache misses', async () => {
      // Stub workspace settings for API key
      const origGetConfig = workspace.getConfiguration;
      workspace.getConfiguration = () => ({
        get: (key: string) => key === 'aicreditsApiKey' ? 'fake-key' : undefined,
      } as any);

      mockPool.query.mockResolvedValueOnce({ rows: [] }); // Cache miss

      const mockResponse = {
        ok: true,
        json: async () => ({
          data: [
            { index: 0, embedding: new Array(1024).fill(0.5) }
          ]
        })
      };
      const origFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue(mockResponse as any);

      try {
        const results = await RAGService.getEmbeddings(['new input']);
        expect(results).toHaveLength(1);
        expect(results[0]).toEqual(new Array(1024).fill(0.5));
        expect(global.fetch).toHaveBeenCalled();
      } finally {
        global.fetch = origFetch;
        workspace.getConfiguration = origGetConfig;
      }
    });
  });

  describe('retrieveContext', () => {
    it('combines Vector and Keyword results using RRF', async () => {
      // Mock getEmbeddings to avoid calling API
      vi.spyOn(RAGService, 'getEmbeddings').mockResolvedValue([new Array(1024).fill(0.1)]);

      // 1. Vector Search returns Match A
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { file_path: '/src/a.ts', relative_path: 'src/a.ts', content: 'content A', similarity: 0.9 }
        ]
      });

      // 2. Keyword Search returns Match B
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { file_path: '/src/b.ts', relative_path: 'src/b.ts', content: 'content B', similarity: 0.5 }
        ]
      });

      // 3. Graph queries (nodes and relations) return empty
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // Local nodes query

      const result = await RAGService.retrieveContext('search query', 2);
      expect(result.context).toContain('content A');
      expect(result.context).toContain('content B');
      expect(result.files).toHaveLength(2);
      expect(result.files[0].relativePath).toBe('src/a.ts');
      expect(result.files[1].relativePath).toBe('src/b.ts');
    });

    it('includes Graph RAG context expansion', async () => {
      vi.spyOn(RAGService, 'getEmbeddings').mockResolvedValue([new Array(1024).fill(0.1)]);

      // Vector Search
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { file_path: '/src/a.ts', relative_path: 'src/a.ts', content: 'content A', similarity: 0.9 }
        ]
      });
      // Keyword Search
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      // Graph RAG - local nodes in matched file
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'node-1', name: 'MyClass', type: 'Class', signature: 'class MyClass', relative_path: 'src/a.ts' }
        ]
      });

      // Graph RAG - related external nodes
      mockPool.query.mockResolvedValueOnce({
        rows: [
          { id: 'node-2', name: 'helperFunc', type: 'Function', signature: 'function helperFunc()', relative_path: 'src/b.ts', file_path: '/src/b.ts' }
        ]
      });

      const result = await RAGService.retrieveContext('search query', 1);
      expect(result.context).toContain('MyClass');
      expect(result.context).toContain('helperFunc');
      expect(result.files).toHaveLength(2); // Local file (a.ts) + external related file (b.ts)
    });
  });
});
