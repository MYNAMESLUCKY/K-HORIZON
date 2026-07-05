import { Pool } from 'pg';
import * as vscode from 'vscode';

const SECRET_KEY_CONNECTION_STRING = 'k-horizon.supabaseConnectionString';
const CONFIG_KEY_CONNECTION_STRING = 'supabaseConnectionString';

export class DBClient {
  private static pool: Pool | undefined;
  private static cachedConnectionString: string | undefined;
  private static secrets: vscode.SecretStorage | undefined;

  /**
   * Initializes the PostgreSQL connection pool using settings.
   * Connection string resolution order:
   *   1. In-memory `cachedConnectionString` (set by storeConnectionString)
   *   2. SecretStorage (via `context.secrets`)
   *   3. VS Code configuration (`k-horizon.supabaseConnectionString`)
   *
   * If no credential is found anywhere, an empty-string pool is created so
   * the extension still activates cleanly; queries will fail with a clear
   * "connection string missing" error rather than a confusing timeout.
   */
  public static async initialize(context?: vscode.ExtensionContext): Promise<Pool> {
    if (context) {
      this.secrets = context.secrets;
    }

    if (this.pool) return this.pool;

    const config = vscode.workspace.getConfiguration('k-horizon');
    const fallbackConnString = config.get<string>(CONFIG_KEY_CONNECTION_STRING, '');

    if (!fallbackConnString && !this.cachedConnectionString && this.secrets) {
      try {
        this.cachedConnectionString = await this.secrets.get(SECRET_KEY_CONNECTION_STRING);
      } catch (err) {
        console.warn('[DBClient] Failed to read Supabase connection string from SecretStorage:', err);
      }
    }

    // Build the initial credential.
    // If settings.json has a connection string, use it. Otherwise, use SecretStorage.
    const resolvedConnString = fallbackConnString
      || this.cachedConnectionString
      || '';

    if (!resolvedConnString) {
      vscode.window.showWarningMessage(
        'K-Horizon: No Supabase connection string configured. Vector search / RAG will be unavailable until you set one. Run "K-Horizon: Set Supabase Connection String" from the command palette, or set `k-horizon.supabaseConnectionString` in your settings.'
      );
      this.pool = {
        query: async () => {
          console.warn('[DBClient] Database query skipped: No connection string configured.');
          return { rows: [] };
        },
        connect: async () => {
          throw new Error('Database connection unavailable: No connection string configured.');
        },
        on: () => {},
        end: async () => {}
      } as any;
      return this.pool!;
    }

    this.pool = new Pool({
      connectionString: resolvedConnString,
      ssl: {
        rejectUnauthorized: false // Required for Supabase external SSL connections
      },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });

    this.pool.on('error', (err) => {
      console.error('Unexpected error on idle database client:', err);
    });

    return this.pool;
  }

  /**
   * Persists a connection string into VS Code's SecretStorage so it is never
   * written to settings.json or source-controlled files.
   */
  public static async storeConnectionString(value: string): Promise<void> {
    if (!this.secrets) {
      throw new Error('SecretStorage not available. Pass ExtensionContext to DBClient.initialize().');
    }
    await this.secrets.store(SECRET_KEY_CONNECTION_STRING, value);
    this.cachedConnectionString = value;
    // Force the pool to be rebuilt with the new credential on next use
    await this.disconnect();
  }

  /**
   * Run initial database migrations (creating tables, enabling pgvector, and
   * building an HNSW index for sub-linear nearest-neighbour search).
   */
  public static async runMigrations(): Promise<void> {
    const pool = await this.initialize();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 1. Enable pgvector extension
      await client.query('CREATE EXTENSION IF NOT EXISTS vector;');

      // Guard: Detect if the existing code_chunks table has an embedding column with a dimension != 1024.
      // If so, drop vector tables to trigger automatic recreation with the new 1024-dim schema.
      try {
        const dimCheck = await client.query(`
          SELECT a.atttypmod 
          FROM pg_attribute a
          JOIN pg_class c ON a.attrelid = c.oid
          WHERE c.relname = 'code_chunks'
            AND a.attname = 'embedding'
            AND a.attnum > 0 
            AND NOT a.attisdropped;
        `);
        if (dimCheck.rows.length > 0) {
          const currentDim = dimCheck.rows[0].atttypmod;
          if (currentDim !== 1024) {
            console.log(`K-Horizon: Migrating database vector columns from ${currentDim} to 1024 dimensions...`);
            await client.query('DROP TABLE IF EXISTS code_chunks CASCADE;');
            await client.query('DROP TABLE IF EXISTS embedding_cache CASCADE;');
            await client.query('DROP TABLE IF EXISTS ast_nodes CASCADE;');
          }
        }
      } catch (err) {
        console.error('Dimension check query failed, proceeding normally:', err);
      }

      // 2. Create code_chunks table (idempotent)
      await client.query(`
        CREATE TABLE IF NOT EXISTS code_chunks (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          file_path TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          content TEXT NOT NULL,
          embedding VECTOR(1024), -- baai/bge-m3 dimension (1024)
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
        );
      `);

      // 3. Create file_summaries table
      await client.query(`
        CREATE TABLE IF NOT EXISTS file_summaries (
          file_path TEXT PRIMARY KEY,
          relative_path TEXT NOT NULL,
          summary TEXT NOT NULL,
          mtime NUMERIC NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
        );
      `);

      // 4. Create chat_history table
      await client.query(`
        CREATE TABLE IF NOT EXISTS chat_history (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp NUMERIC NOT NULL
        );
      `);

      // 5. Add session columns to chat_history
      await client.query(`
        ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS session_id TEXT NOT NULL DEFAULT 'default';
      `);
      await client.query(`
        ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS session_title TEXT DEFAULT 'New Conversation';
      `);

      // 6. Create embedding_cache table keyed by SHA-256 of input text.
      //    Avoids re-embedding identical chunks on re-index.
      await client.query(`
        CREATE TABLE IF NOT EXISTS embedding_cache (
          content_hash TEXT PRIMARY KEY,
          embedding VECTOR(1024) NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
        );
      `);

      // 7. Create ast_nodes table
      await client.query(`
        CREATE TABLE IF NOT EXISTS ast_nodes (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          file_path TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          signature TEXT NOT NULL,
          content TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          embedding VECTOR(1024),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
        );
      `);

      // 8. Create ast_relations table
      await client.query(`
        CREATE TABLE IF NOT EXISTS ast_relations (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          file_path TEXT NOT NULL,
          source_node_id UUID REFERENCES ast_nodes(id) ON DELETE CASCADE,
          target_node_id UUID REFERENCES ast_nodes(id) ON DELETE CASCADE,
          target_name TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
        );
      `);

      await client.query('COMMIT');

      // 9. Build HNSW indexes for sub-linear cosine distance search (outside main transaction)
      try {
        await client.query(`
          CREATE INDEX IF NOT EXISTS code_chunks_embedding_hnsw
          ON code_chunks
          USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 64);
        `);
      } catch (indexErr: any) {
        console.warn('K-Horizon: HNSW index creation skipped for code_chunks (likely due to pgvector dimension limits):', indexErr.message);
      }

      try {
        await client.query(`
          CREATE INDEX IF NOT EXISTS ast_nodes_embedding_hnsw
          ON ast_nodes
          USING hnsw (embedding vector_cosine_ops)
          WITH (m = 16, ef_construction = 64);
        `);
      } catch (indexErr: any) {
        console.warn('K-Horizon: HNSW index creation skipped for ast_nodes:', indexErr.message);
      }
      console.log('K-Horizon Database migrations completed successfully!');
    } catch (error: any) {
      await client.query('ROLLBACK');
      vscode.window.showErrorMessage(`Database migrations failed: ${error.message}`);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Closes the connection pool.
   */
  public static async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }
  }

  /**
   * Returns true when the pool has been initialized with a non-empty
   * connection string. Use this to gate DB-dependent UI paths so they
   * degrade gracefully instead of throwing "connection refused" mid-flow.
   */
  public static async hasConnectionString(): Promise<boolean> {
    if (this.cachedConnectionString && this.cachedConnectionString.trim()) {
      return true;
    }
    try {
      const config = vscode.workspace.getConfiguration('k-horizon');
      const fallback = config.get<string>(CONFIG_KEY_CONNECTION_STRING, '');
      if (fallback && fallback.trim()) {
        return true;
      }
    } catch {
      return false;
    }
    if (!this.secrets) {
      return false;
    }
    try {
      const secretValue = await this.secrets.get(SECRET_KEY_CONNECTION_STRING);
      if (secretValue && secretValue.trim()) {
        this.cachedConnectionString = secretValue;
        return true;
      }
    } catch {}
    return false;
  }
}
