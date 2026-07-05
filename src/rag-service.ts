import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { DBClient } from './db-client';
import { ASTParser } from './ast-parser';

export class RAGService {
  // In-memory embedding cache to short-circuit repeated identical queries
  // within a single session (e.g. follow-up chat turns that re-issue the
  // same RAG retrieval prompt).
  private static memoryEmbeddingCache = new Map<string, number[]>();

  /**
   * Returns a stable SHA-256 hex digest of an arbitrary text payload.
   */
  private static hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Looks up a previously cached embedding for a given text from PostgreSQL.
   * Returns null if the embedding has never been computed.
   */
  private static async getCachedEmbedding(content: string): Promise<number[] | null> {
    const hash = this.hashContent(content);
    if (this.memoryEmbeddingCache.has(hash)) {
      return this.memoryEmbeddingCache.get(hash)!;
    }
    try {
      const pool = await DBClient.initialize();
      const res = await pool.query(
        'SELECT embedding::text AS emb FROM embedding_cache WHERE content_hash = $1',
        [hash]
      );
      if (res.rows.length > 0) {
        const text = res.rows[0].emb as string; // e.g. '[0.1,0.2,...]'
        const parsed = text.replace(/[\[\]]/g, '').split(',').map(Number);
        this.memoryEmbeddingCache.set(hash, parsed);
        return parsed;
      }
    } catch (e) {
      console.error('Embedding cache lookup failed:', e);
    }
    return null;
  }

  /**
   * Persists a freshly computed embedding to the cache for future reuse.
   */
  private static async storeCachedEmbedding(content: string, embedding: number[]): Promise<void> {
    const hash = this.hashContent(content);
    this.memoryEmbeddingCache.set(hash, embedding);
    try {
      const pool = await DBClient.initialize();
      const vectorStr = `[${embedding.join(',')}]`;
      await pool.query(
        `INSERT INTO embedding_cache (content_hash, embedding) 
         VALUES ($1, $2::vector) 
         ON CONFLICT (content_hash) DO NOTHING`,
        [hash, vectorStr]
      );
    } catch (e) {
      // Cache write failures are non-fatal
      console.error('Embedding cache write failed:', e);
    }
  }

  /**
   * Queries the aicredits.in API to get the embedding vector for a batch of
   * text inputs. Checks the embedding_cache table first to avoid redundant
   * API calls for already-embedded content.
   */
  public static async getEmbeddings(inputs: string[]): Promise<number[][]> {
    const results: (number[] | null)[] = new Array(inputs.length).fill(null);
    const missingIndexes: number[] = [];

    // 1. Try cache first for each input
    for (let i = 0; i < inputs.length; i++) {
      const cached = await this.getCachedEmbedding(inputs[i]);
      if (cached) {
        results[i] = cached;
      } else {
        missingIndexes.push(i);
      }
    }

    // 2. If everything was cached, return early
    if (missingIndexes.length === 0) {
      return results as number[][];
    }

    const config = vscode.workspace.getConfiguration('k-horizon');
    const apiKey = config.get<string>('aicreditsApiKey', '');

    if (!apiKey) {
      vscode.window.showErrorMessage(
        'K-Horizon RAG: Please set your aicredits.in API Key in settings (k-horizon.aicreditsApiKey).'
      );
      throw new Error('Missing AI Credits API Key');
    }

    const url = 'https://api.aicredits.in/v1/embeddings';

    // 3. Only embed the cache misses
    const missingInputs = missingIndexes.map(i => inputs[i]);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s for batch

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          input: missingInputs,
          model: 'baai/bge-m3'
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`AI Credits API error ${response.status}: ${errText}`);
      }

      const data: any = await response.json();
      if (!data.data || !Array.isArray(data.data)) {
        throw new Error('Invalid embeddings response structure');
      }

      // Sort by index to maintain original order
      const sortedData = data.data.sort((a: any, b: any) => a.index - b.index);

      // 4. Persist freshly computed embeddings to the cache and fill results
      for (let j = 0; j < sortedData.length; j++) {
        const emb: number[] = sortedData[j].embedding;
        const originalIdx = missingIndexes[j];
        results[originalIdx] = emb;
        // Fire-and-forget cache write; do not await in the hot path
        this.storeCachedEmbedding(inputs[originalIdx], emb).catch(() => {});
      }

      return results as number[][];
    } catch (e: any) {
      console.error('Failed to generate embedding:', e);
      throw e;
    }
  }

  /**
   * Chunks a file into lines segments of ~30 lines, with 5 lines of overlap.
   */
  public static chunkFile(relativePath: string, content: string): string[] {
    const lines = content.split('\n');
    const chunks: string[] = [];
    const chunkSize = 35;
    const overlap = 5;

    if (lines.length <= chunkSize) {
      // Small file, just one chunk
      chunks.push(`// File: ${relativePath}\n${content}`);
      return chunks;
    }

    for (let i = 0; i < lines.length; i += (chunkSize - overlap)) {
      const chunkLines = lines.slice(i, i + chunkSize);
      // Skip degenerate trailing fragments that contain only whitespace,
      // but still emit a final chunk if the file ends mid-window.
      if (chunkLines.length < overlap && chunks.length > 0) {
        const remaining = chunkLines.join('\n').trim();
        if (!remaining) break;
      }

      const chunkText = chunkLines.join('\n');
      chunks.push(`// File: ${relativePath} (Lines ${i + 1}-${i + chunkLines.length})\n${chunkText}`);
    }

    return chunks;
  }

  /**
   * Indexes a single file by chunking it, creating embeddings, and storing them in Supabase.
   * Also parses and indexes AST nodes/relations for JS/TS files.
   */
  public static async indexFile(filePath: string, relativePath: string, content: string): Promise<void> {
    const pool = await DBClient.initialize();
    const client = await pool.connect();

    try {
      // 1. Delete existing chunks and AST data for this file
      await client.query('DELETE FROM code_chunks WHERE file_path = $1', [filePath]);
      await client.query('DELETE FROM ast_relations WHERE file_path = $1', [filePath]);
      await client.query('DELETE FROM ast_nodes WHERE file_path = $1', [filePath]);

      // If file is empty, just stop here
      if (!content.trim()) return;

      // 2. Split file into chunks
      const chunks = this.chunkFile(relativePath, content);

      // 3. Parse AST if TS/JS/Python/Go/Rust/Java
      const isSupported = /\.(js|ts|jsx|tsx|py|go|rs|java)$/i.test(filePath);
      const astResult = isSupported ? ASTParser.parse(filePath, content) : { nodes: [], relations: [] };

      // 4. Batch generate embeddings for chunks and AST nodes
      const allTextsToEmbed = [...chunks];
      astResult.nodes.forEach(node => {
        allTextsToEmbed.push(`${node.type} ${node.name}: ${node.signature}`);
      });

      const allEmbeddings = await this.getEmbeddings(allTextsToEmbed);
      const chunkEmbeddings = allEmbeddings.slice(0, chunks.length);
      const astEmbeddings = allEmbeddings.slice(chunks.length);

      // 5. Batch insert into database
      await client.query('BEGIN');
      
      // Insert chunks
      for (let i = 0; i < chunks.length; i++) {
        const vectorStr = `[${chunkEmbeddings[i].join(',')}]`;
        await client.query(
          `INSERT INTO code_chunks (file_path, relative_path, content, embedding) 
           VALUES ($1, $2, $3, $4::vector)`,
          [filePath, relativePath, chunks[i], vectorStr]
        );
      }

      // Insert AST Nodes
      const nameToNodeId = new Map<string, string>();
      for (let i = 0; i < astResult.nodes.length; i++) {
        const node = astResult.nodes[i];
        const vectorStr = `[${astEmbeddings[i].join(',')}]`;
        const nodeRes = await client.query(
          `INSERT INTO ast_nodes (file_path, relative_path, name, type, signature, content, start_line, end_line, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)
           RETURNING id`,
          [filePath, relativePath, node.name, node.type, node.signature, node.content, node.startLine, node.endLine, vectorStr]
        );
        nameToNodeId.set(node.name, nodeRes.rows[0].id);
      }

      // Insert AST Relations
      for (const rel of astResult.relations) {
        let sourceNodeId: string | null = null;
        let targetNodeId: string | null = null;

        if (rel.relationType === 'DEFINES') {
          const dotIdx = rel.targetName.indexOf('.');
          if (dotIdx !== -1) {
            const className = rel.targetName.substring(0, dotIdx);
            sourceNodeId = nameToNodeId.get(className) || null;
          }
          targetNodeId = nameToNodeId.get(rel.targetName) || null;
        }

        await client.query(
          `INSERT INTO ast_relations (file_path, source_node_id, target_node_id, target_name, relation_type)
           VALUES ($1, $2, $3, $4, $5)`,
          [filePath, sourceNodeId, targetNodeId, rel.targetName, rel.relationType]
        );
      }

      await client.query('COMMIT');
      console.log(`Indexed file ${relativePath} successfully (${chunks.length} chunks, ${astResult.nodes.length} AST nodes)`);
    } catch (e: any) {
      await client.query('ROLLBACK');
      console.error(`Failed to index file ${relativePath}:`, e.message);
    } finally {
      client.release();
    }
  }

  /**
   * Deletes a file's chunks and AST entries from index (e.g. on file deletion).
   */
  public static async deleteFileFromIndex(filePath: string): Promise<void> {
    const pool = await DBClient.initialize();
    try {
      await pool.query('DELETE FROM code_chunks WHERE file_path = $1', [filePath]);
      await pool.query('DELETE FROM ast_relations WHERE file_path = $1', [filePath]);
      await pool.query('DELETE FROM ast_nodes WHERE file_path = $1', [filePath]);
    } catch (e) {
      console.error('Failed to delete file from index:', e);
    }
  }

  /**
   * Performs hybrid cosine similarity and keyword search using pgvector + RRF (Reciprocal Rank Fusion).
   */
  public static async retrieveContext(query: string, matchCount = 4): Promise<{ context: string; files: { filePath: string; relativePath: string; }[] }> {
    const pool = await DBClient.initialize();
    
    try {
      // 1. Vector Search
      let vectorRows: any[] = [];
      try {
        const queryEmbedding = await this.getEmbeddings([query]);
        const vectorStr = `[${queryEmbedding[0].join(',')}]`;
        const vecResult = await pool.query(
          `SELECT file_path, relative_path, content, 1 - (embedding <=> $1::vector) as similarity
           FROM code_chunks
           WHERE 1 - (embedding <=> $1::vector) > 0.35
           ORDER BY embedding <=> $1::vector
           LIMIT 10`,
          [vectorStr]
        );
        vectorRows = vecResult.rows;
      } catch (embErr) {
        console.error('Vector search embedding failed, falling back to keyword search only:', embErr);
      }

      // 2. Keyword Search
      const keywords = query.split(/\s+/).map(k => k.replace(/[^a-zA-Z0-9]/g, '')).filter(k => k.length > 2);
      let keywordRows: any[] = [];
      if (keywords.length > 0) {
        const likeClauses = keywords.map((_, idx) => `content ILIKE $${idx + 1}`).join(' OR ');
        const likeParams = keywords.map(k => `%${k}%`);
        try {
          const kwResult = await pool.query(
            `SELECT file_path, relative_path, content, 0.5 as similarity
             FROM code_chunks
             WHERE ${likeClauses}
             LIMIT 10`,
            likeParams
          );
          keywordRows = kwResult.rows;
        } catch (kwErr) {
          console.error('Keyword search failed:', kwErr);
        }
      }

      // 3. Reciprocal Rank Fusion (RRF)
      const docMap = new Map<string, { doc: any; vectorRank: number; keywordRank: number }>();
      
      vectorRows.forEach((row, idx) => {
        docMap.set(row.content, { doc: row, vectorRank: idx + 1, keywordRank: Infinity });
      });

      keywordRows.forEach((row, idx) => {
        const key = row.content;
        if (docMap.has(key)) {
          docMap.get(key)!.keywordRank = idx + 1;
        } else {
          docMap.set(key, { doc: row, vectorRank: Infinity, keywordRank: idx + 1 });
        }
      });

      const rrfDocs = Array.from(docMap.values()).map(item => {
        const vScore = item.vectorRank === Infinity ? 0 : 1 / (60 + item.vectorRank);
        const kScore = item.keywordRank === Infinity ? 0 : 1 / (60 + item.keywordRank);
        const score = vScore + kScore;
        return { doc: item.doc, score };
      });

      rrfDocs.sort((a, b) => b.score - a.score);
      const topDocs = rrfDocs.slice(0, matchCount).map(x => x.doc);

      if (topDocs.length === 0) {
        return { context: '', files: [] };
      }

      // 4. Format output context and collect files
      let context = '### Hybrid Semantic/Keyword Relevant Code Chunks:\n\n';
      const files: { filePath: string; relativePath: string; }[] = [];
      topDocs.forEach((row, i) => {
        context += `--- Match #${i + 1} in \`${row.relative_path}\` ---\n`;
        context += `${row.content}\n\n`;
        if (!files.some(f => f.filePath === row.file_path)) {
          files.push({ filePath: row.file_path, relativePath: row.relative_path });
        }
      });

      // --- Graph RAG Context Expansion ---
      try {
        const filePaths = Array.from(new Set(topDocs.map(d => d.file_path)));
        if (filePaths.length > 0) {
          // 1. Get all AST nodes defined in the matched files
          const nodesRes = await pool.query(
            `SELECT id, name, type, signature, relative_path 
             FROM ast_nodes 
             WHERE file_path = ANY($1)`,
            [filePaths]
          );
          const localNodes = nodesRes.rows;
          const localNodeIds = localNodes.map(n => n.id);

          // 2. Fetch related nodes (either source or target of relations involving local nodes, or imports from these files)
          let relatedNodes: any[] = [];
          if (localNodeIds.length > 0) {
            const relRes = await pool.query(
              `SELECT DISTINCT n.id, n.name, n.type, n.signature, n.relative_path, n.file_path
               FROM ast_relations r
               JOIN ast_nodes n ON (n.id = r.target_node_id OR n.id = r.source_node_id)
               WHERE (r.source_node_id = ANY($1) OR r.target_node_id = ANY($1))
                 AND NOT (n.file_path = ANY($2))`,
              [localNodeIds, filePaths]
            );
            relatedNodes = relRes.rows;
          }

          // 3. Format the Graph context
          if (localNodes.length > 0 || relatedNodes.length > 0) {
            let graphContext = '\n### Graph RAG Code Structure & Relations:\n\n';
            if (localNodes.length > 0) {
              graphContext += '#### Symbols Defined in Matched Files:\n';
              localNodes.forEach(n => {
                graphContext += `- **${n.name}** (\`${n.type}\`) in \`${n.relative_path}\` -> \`${n.signature}\`\n`;
              });
              graphContext += '\n';
            }
            if (relatedNodes.length > 0) {
              graphContext += '#### Related External Symbols (via Import/Dependency Graph):\n';
              relatedNodes.forEach(n => {
                graphContext += `- **${n.name}** (\`${n.type}\`) in \`${n.relative_path}\` -> \`${n.signature}\`\n`;
                if (!files.some(f => f.filePath === n.file_path)) {
                  files.push({ filePath: n.file_path, relativePath: n.relative_path });
                }
              });
              graphContext += '\n';
            }
            context += graphContext;
          }
        }
      } catch (graphErr) {
        console.error('Graph RAG context expansion failed:', graphErr);
      }

      return { context, files };
    } catch (e: any) {
      console.error('Failed retrieving hybrid context:', e);
      return { context: '', files: [] };
    }
  }
}
