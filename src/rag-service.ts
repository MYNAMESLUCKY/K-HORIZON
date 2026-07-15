import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { DBClient } from './db-client';
import { ASTParser } from './ast-parser';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from './workspace-utils';

export class RAGService {
  // In-memory embedding cache to short-circuit repeated identical queries
  // within a single session (e.g. follow-up chat turns that re-issue the
  // same RAG retrieval prompt).
  private static memoryEmbeddingCache = new Map<string, number[]>();

  private static normalizeGeminiEmbeddingsUrl(baseUrl: string): string {
    let url = (baseUrl || 'https://generativelanguage.googleapis.com/v1beta/openai/embeddings').trim();
    if (url.endsWith('/')) {
      url = url.slice(0, -1);
    }
    if (url.includes('generativelanguage.googleapis.com') && !url.includes('/openai/')) {
      if (url.endsWith('/v1beta') || url.endsWith('/v1')) {
        return `${url}/openai/embeddings`;
      }
      return `${url}/v1beta/openai/embeddings`;
    }
    if (!url.endsWith('/embeddings')) {
      if (url.endsWith('/v1') || url.endsWith('/v1beta')) {
        return `${url}/embeddings`;
      }
      return `${url}/v1/embeddings`;
    }
    return url;
  }

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
    const provider = config.get<string>('embeddingProvider', 'AICredits');
    const model = config.get<string>('embeddingModel', 'baai/bge-m3');
    const configApiKey = config.get<string>('embeddingApiKey', '');
    const aicreditsApiKey = config.get<string>('aicreditsApiKey', '');
    const configBaseUrl = config.get<string>('embeddingBaseURL', '');

    let apiKey = configApiKey || (provider === 'AICredits' ? aicreditsApiKey : '');
    let url = configBaseUrl;
    let headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    let body: any = {};
    const missingInputs = missingIndexes.map(i => inputs[i]);

    switch (provider) {
      case 'AICredits':
        url = url || 'https://api.aicredits.in/v1/embeddings';
        if (!apiKey) {
          vscode.window.showErrorMessage(
            'K-Horizon RAG: Please set your AI Credits API Key in settings (k-horizon.embeddingApiKey or k-horizon.aicreditsApiKey).'
          );
          throw new Error('Missing AI Credits API Key');
        }
        headers['Authorization'] = `Bearer ${apiKey}`;
        body = {
          input: missingInputs,
          model: model || 'baai/bge-m3'
        };
        break;

      case 'OpenAI':
        url = url || 'https://api.openai.com/v1/embeddings';
        if (!apiKey) {
          vscode.window.showErrorMessage('K-Horizon RAG: Please set your OpenAI API Key in settings (k-horizon.embeddingApiKey).');
          throw new Error('Missing OpenAI API Key');
        }
        headers['Authorization'] = `Bearer ${apiKey}`;
        body = {
          input: missingInputs,
          model: model || 'text-embedding-3-small'
        };
        break;

      case 'Gemini':
        url = this.normalizeGeminiEmbeddingsUrl(url);
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        if (!apiKey) {
          vscode.window.showErrorMessage('K-Horizon RAG: Please set your Gemini API Key in settings (k-horizon.embeddingApiKey).');
          throw new Error('Missing Gemini API Key');
        }
        body = {
          input: missingInputs,
          model: model || 'text-embedding-004'
        };
        break;

      case 'Ollama':
        url = url || 'http://127.0.0.1:11434/v1/embeddings';
        body = {
          input: missingInputs,
          model: model || 'nomic-embed-text'
        };
        break;

      case 'Custom':
      default:
        url = url || 'https://api.openai.com/v1/embeddings';
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        body = {
          input: missingInputs,
          model: model
        };
        break;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s for batch

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
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
    const hasDB = await DBClient.hasConnectionString();
    if (!hasDB) {
      await this.indexFileLocally(filePath, relativePath, content);
      return;
    }
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
    const hasDB = await DBClient.hasConnectionString();
    if (!hasDB) {
      try {
        const index = await this.loadLocalIndex();
        index.code_chunks = (index.code_chunks || []).filter((c: any) => c.file_path !== filePath);
        index.ast_nodes = (index.ast_nodes || []).filter((n: any) => n.file_path !== filePath);
        index.ast_relations = (index.ast_relations || []).filter((r: any) => r.file_path !== filePath);
        await this.saveLocalIndex(index);
      } catch (e) {
        console.error('Failed to delete file from local index:', e);
      }
      return;
    }

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
    const hasDB = await DBClient.hasConnectionString();
    if (!hasDB) {
      return await this.retrieveContextLocally(query, matchCount);
    }

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
            `SELECT file_path, relative_path, content
             FROM code_chunks
             WHERE ${likeClauses}`,
            likeParams
          );
          const dbRows = kwResult.rows;
          const ranked = this.rankBM25(dbRows, query);
          keywordRows = ranked.length > 0 ? ranked.slice(0, 10) : dbRows.slice(0, 10);
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

  // --- Local Vector Fallback Methods ---

  private static async getLocalIndexFilePath(): Promise<string | null> {
    const root = getWorkspaceRoot();
    if (!root) return null;
    const dir = path.join(root, '.k-horizon');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, 'local-index.json');
  }

  private static async loadLocalIndex(): Promise<any> {
    const file = await this.getLocalIndexFilePath();
    if (file && fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw);
      } catch (e) {
        console.error('Failed to parse local index JSON:', e);
      }
    }
    return { code_chunks: [], ast_nodes: [], ast_relations: [] };
  }

  private static async saveLocalIndex(index: any): Promise<void> {
    const file = await this.getLocalIndexFilePath();
    if (file) {
      try {
        fs.writeFileSync(file, JSON.stringify(index, null, 2), 'utf8');
      } catch (e) {
        console.error('Failed to save local index:', e);
      }
    }
  }

  private static cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let mA = 0;
    let mB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      mA += a[i] * a[i];
      mB += b[i] * b[i];
    }
    if (mA === 0 || mB === 0) return 0;
    return dotProduct / (Math.sqrt(mA) * Math.sqrt(mB));
  }

  public static async indexFileLocally(filePath: string, relativePath: string, content: string): Promise<void> {
    try {
      const index = await this.loadLocalIndex();

      // 1. Delete existing chunks and AST data for this file
      index.code_chunks = (index.code_chunks || []).filter((c: any) => c.file_path !== filePath);
      index.ast_nodes = (index.ast_nodes || []).filter((n: any) => n.file_path !== filePath);
      index.ast_relations = (index.ast_relations || []).filter((r: any) => r.file_path !== filePath);

      // If file is empty, just save and stop
      if (!content.trim()) {
        await this.saveLocalIndex(index);
        return;
      }

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

      // 5. Insert chunks
      for (let i = 0; i < chunks.length; i++) {
        index.code_chunks.push({
          file_path: filePath,
          relative_path: relativePath,
          content: chunks[i],
          embedding: chunkEmbeddings[i]
        });
      }

      // 6. Insert AST Nodes
      const nameToNodeId = new Map<string, string>();
      for (let i = 0; i < astResult.nodes.length; i++) {
        const node = astResult.nodes[i];
        const nodeId = 'node_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
        index.ast_nodes.push({
          id: nodeId,
          file_path: filePath,
          relative_path: relativePath,
          name: node.name,
          type: node.type,
          signature: node.signature,
          content: node.content,
          start_line: node.startLine,
          end_line: node.endLine,
          embedding: astEmbeddings[i]
        });
        nameToNodeId.set(node.name, nodeId);
      }

      // 7. Insert AST Relations
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

        index.ast_relations.push({
          file_path: filePath,
          source_node_id: sourceNodeId,
          target_node_id: targetNodeId,
          target_name: rel.targetName,
          relation_type: rel.relationType
        });
      }

      await this.saveLocalIndex(index);
      console.log(`Locally indexed file ${relativePath} successfully (${chunks.length} chunks, ${astResult.nodes.length} AST nodes)`);
    } catch (e: any) {
      console.error(`Failed to locally index file ${relativePath}:`, e.message);
    }
  }

  private static async retrieveContextLocally(query: string, matchCount = 4): Promise<{ context: string; files: { filePath: string; relativePath: string; }[] }> {
    try {
      const index = await this.loadLocalIndex();
      const chunks = index.code_chunks || [];
      if (chunks.length === 0) {
        return { context: '', files: [] };
      }

      // 1. Vector Search locally
      let queryEmbedding: number[] = [];
      try {
        const embs = await this.getEmbeddings([query]);
        queryEmbedding = embs[0];
      } catch (e) {
        console.error('Local vector search embedding failed, using keyword search only:', e);
      }

      const scoredChunks: { chunk: any; similarity: number }[] = [];
      if (queryEmbedding.length > 0) {
        chunks.forEach((chunk: any) => {
          if (chunk.embedding && chunk.embedding.length > 0) {
            const similarity = this.cosineSimilarity(queryEmbedding, chunk.embedding);
            if (similarity > 0.35) {
              scoredChunks.push({ chunk, similarity });
            }
          }
        });
      }

      scoredChunks.sort((a, b) => b.similarity - a.similarity);
      const vectorRows = scoredChunks.slice(0, 10).map(x => x.chunk);

      // 2. Keyword Search locally using BM25 with fallback
      const keywords = query.split(/\s+/).map(k => k.replace(/[^a-zA-Z0-9]/g, '')).filter(k => k.length > 2);
      let keywordRows = this.rankBM25(chunks, query).slice(0, 10);
      if (keywordRows.length === 0 && keywords.length > 0) {
        const matching = chunks.filter((chunk: any) => {
          return keywords.some(kw => chunk.content.toLowerCase().includes(kw.toLowerCase()));
        });
        keywordRows = matching.slice(0, 10);
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

      // 5. Local Graph RAG Context Expansion
      try {
        const filePaths = Array.from(new Set(topDocs.map(d => d.file_path)));
        if (filePaths.length > 0 && index.ast_nodes) {
          const filePathsSet = new Set(filePaths);
          const localNodes = index.ast_nodes.filter((n: any) => filePathsSet.has(n.file_path));
          const localNodeIds = new Set(localNodes.map((n: any) => n.id));

          const relatedNodeIds = new Set<string>();
          if (index.ast_relations) {
            index.ast_relations.forEach((rel: any) => {
              const isSourceLocal = rel.source_node_id && localNodeIds.has(rel.source_node_id);
              const isTargetLocal = rel.target_node_id && localNodeIds.has(rel.target_node_id);
              if (isSourceLocal || isTargetLocal) {
                if (rel.source_node_id) relatedNodeIds.add(rel.source_node_id);
                if (rel.target_node_id) relatedNodeIds.add(rel.target_node_id);
              }
            });
          }

          const relatedNodes = index.ast_nodes.filter((n: any) => 
            relatedNodeIds.has(n.id) && !filePathsSet.has(n.file_path)
          );

          if (localNodes.length > 0 || relatedNodes.length > 0) {
            let graphContext = '\n### Graph RAG Code Structure & Relations:\n\n';
            if (localNodes.length > 0) {
              graphContext += '#### Symbols Defined in Matched Files:\n';
              localNodes.forEach((n: any) => {
                graphContext += `- **${n.name}** (\`${n.type}\`) in \`${n.relative_path}\` -> \`${n.signature}\`\n`;
              });
              graphContext += '\n';
            }
            if (relatedNodes.length > 0) {
              graphContext += '#### Related External Symbols (via Import/Dependency Graph):\n';
              relatedNodes.forEach((n: any) => {
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
        console.error('Local Graph RAG context expansion failed:', graphErr);
      }

      return { context, files };
    } catch (e: any) {
      console.error('Failed retrieving hybrid context locally:', e);
      return { context: '', files: [] };
    }
  }

  private static rankBM25(chunks: any[], query: string): any[] {
    const words = query.toLowerCase().split(/\s+/).map(k => k.replace(/[^a-zA-Z0-9]/g, '')).filter(k => k.length > 1);
    if (words.length === 0 || chunks.length === 0) return [];

    const N = chunks.length;
    const docLengths = chunks.map(c => c.content.split(/\s+/).length);
    const avgdl = docLengths.reduce((sum, len) => sum + len, 0) / N;

    const docFreq: Record<string, number> = {};
    for (const word of words) {
      docFreq[word] = 0;
      for (const chunk of chunks) {
        if (chunk.content.toLowerCase().includes(word)) {
          docFreq[word]++;
        }
      }
    }

    const k1 = 1.2;
    const b = 0.75;
    const scored: { chunk: any; score: number }[] = [];

    chunks.forEach((chunk, docIdx) => {
      let score = 0;
      const contentLower = chunk.content.toLowerCase();
      const docLen = docLengths[docIdx];

      for (const word of words) {
        const df = docFreq[word] || 0;
        if (df === 0) continue;

        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const tf = contentLower.split(word).length - 1;
        if (tf === 0) continue;

        const termScore = idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgdl)));
        score += termScore;
      }

      if (score > 0) {
        scored.push({ chunk, score });
      }
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.map(x => x.chunk);
  }
}
