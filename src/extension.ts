import * as vscode from 'vscode';
import { SidebarProvider } from './sidebar-provider';
import { ComposerProvider } from './composer-provider';
import { InlineEditManager } from './inline-edit';
import { AutocompleteProvider } from './autocomplete-provider';
import { DBClient } from './db-client';
import { RAGService } from './rag-service';
import { MCPManager } from './mcp-manager';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from './workspace-utils';

let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
  console.log('K-HORIZON is now active!');

  // 0. Load repo-level instruction files into globalState so every provider
  //    (sidebar, composer, inline-edit, autocomplete) can inject them into
  //    the system prompt without re-reading from disk on every turn.
  loadRepoInstructions(context);

  // 1. Run Supabase PostgreSQL Migrations on Activation
  try {
    await DBClient.initialize(context);
    if (await DBClient.hasConnectionString()) {
      await DBClient.runMigrations();
    } else {
      console.log('K-Horizon: Skipping database migrations (connection string is not configured yet).');
    }
  } catch (err: any) {
    vscode.window.showErrorMessage(`Supabase Connection Error: ${err.message}. Vector search functions will be disabled.`);
  }

  // 2. Trigger asynchronous codebase synchronization for pgvector RAG search
  syncCodebaseIndex(context);

  // 3. Register document hooks for incremental vector updates on save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const filePath = document.uri.fsPath;
      if (!shouldIndexFile(filePath)) {
        return;
      }
      const rel = vscode.workspace.asRelativePath(document.uri);
      if (
        rel.includes('node_modules') || 
        rel.includes('.git') || 
        rel.includes('dist') || 
        rel.includes('out') ||
        rel.includes('build')
      ) {
        return;
      }
      try {
        await RAGService.indexFile(filePath, rel, document.getText());
        const mtimes = context.workspaceState.get<Record<string, number>>('indexedFilesMtimes') || {};
        try {
          const fs = require('fs');
          mtimes[filePath] = fs.statSync(filePath).mtimeMs;
          await context.workspaceState.update('indexedFilesMtimes', mtimes);
        } catch (err) {}
      } catch (e) {}
    })
  );

  // Watch for deleted files to wipe their embeddings
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  fileWatcher.onDidDelete(async (uri) => {
    const rel = vscode.workspace.asRelativePath(uri);
    if (
      rel.includes('node_modules') || 
      rel.includes('.git') || 
      rel.includes('dist') || 
      rel.includes('out') ||
      rel.includes('build') ||
      rel.includes('package-lock.json')
    ) {
      return;
    }
    try {
      await RAGService.deleteFileFromIndex(uri.fsPath);
      const mtimes = context.workspaceState.get<Record<string, number>>('indexedFilesMtimes') || {};
      delete mtimes[uri.fsPath];
      await context.workspaceState.update('indexedFilesMtimes', mtimes);
    } catch (e) {}
  });
  context.subscriptions.push(fileWatcher);

  // Initialize Inline Editor Diff decorations and key actions
  InlineEditManager.initialize(context);

  // Initialize Composer Provider commands
  ComposerProvider.initialize(context);

  // Initialize MCP Manager
  MCPManager.initialize(context);

  // Register Sidebar Chat Provider with retainContextWhenHidden to prevent state loss when hidden/inactive
  const sidebarProvider = new SidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  // Register Inline Completions (Autocomplete) Provider
  const autocompleteProvider = new AutocompleteProvider();
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      autocompleteProvider
    )
  );

  // Register Main Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('k-horizon.inline-edit', () => {
      InlineEditManager.triggerInlineEdit();
    }),

    vscode.commands.registerCommand('k-horizon.toggle-autocomplete', async () => {
      const config = vscode.workspace.getConfiguration('k-horizon');
      const current = config.get<boolean>('enableAutocomplete', true);
      await config.update('enableAutocomplete', !current, vscode.ConfigurationTarget.Global);
      updateStatusBar();
      vscode.window.showInformationMessage(`K-Horizon Autocomplete: ${!current ? 'Enabled' : 'Disabled'}`);
    }),

    vscode.commands.registerCommand('k-horizon.chat-clear', () => {
      sidebarProvider.clearHistory();
    }),

    // Securely store the Supabase connection string into SecretStorage so it
    // never lands in settings.json. After storing, the DB pool is rebuilt
    // and migrations + RAG indexing are re-attempted.
    vscode.commands.registerCommand('k-horizon.set-supabase-connection', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Enter your Supabase PostgreSQL connection string',
        placeHolder: 'postgresql://postgres:password@db.xxx.supabase.co:5432/postgres',
        password: true,
        ignoreFocusOut: true,
        validateInput: (v) => {
          if (!v || !v.trim()) return 'Connection string cannot be empty';
          if (!/^postgres(?:ql)?:\/\//i.test(v.trim())) {
            return 'Must start with postgresql:// or postgres://';
          }
          return undefined;
        }
      });
      if (!value) return;
      try {
        // Ensure context.secrets is wired up before storing
        await DBClient.initialize(context);
        await DBClient.storeConnectionString(value.trim());
        vscode.window.showInformationMessage('Supabase connection string saved to SecretStorage. Re-running migrations...');
        try {
          await DBClient.runMigrations();
        } catch (migErr: any) {
          vscode.window.showErrorMessage(`Migrations failed after storing credential: ${migErr.message}`);
        }
        // Kick off (or re-kick) RAG indexing now that the credential is live
        syncCodebaseIndex(context);
        updateStatusBar();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to save connection string: ${err.message}`);
      }
    })
  );

  // Add a status bar shortcut item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'k-horizon.toggle-autocomplete';
  context.subscriptions.push(statusBarItem);

  // Initial update
  updateStatusBar();
  statusBarItem.show();

  // Watch for config updates to refresh status bar and reset database pool on credentials change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('k-horizon.enableAutocomplete')) {
        updateStatusBar();
      }
      if (e.affectsConfiguration('k-horizon.supabaseConnectionString')) {
        await DBClient.disconnect();
        try {
          await DBClient.initialize(context);
          await DBClient.runMigrations();
        } catch (migErr: any) {
          vscode.window.showErrorMessage(`Migrations failed after connection string update: ${migErr.message}`);
        }
        syncCodebaseIndex(context);
      }
      if (
        e.affectsConfiguration('k-horizon.embeddingProvider') ||
        e.affectsConfiguration('k-horizon.embeddingModel') ||
        e.affectsConfiguration('k-horizon.embeddingApiKey') ||
        e.affectsConfiguration('k-horizon.embeddingBaseURL') ||
        e.affectsConfiguration('k-horizon.aicreditsApiKey')
      ) {
        syncCodebaseIndex(context);
      }
    })
  );
}

/**
 * Reads `.github/copilot-instructions.md` and `AGENTS.md` from the workspace
 * root (if present) and stores their combined content in globalState so every
 * provider can inject them into the system prompt without re-reading disk.
 */
function loadRepoInstructions(context: vscode.ExtensionContext) {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return;

  const paths = [
    path.join(workspaceRoot, '.github', 'copilot-instructions.md'),
    path.join(workspaceRoot, 'AGENTS.md'),
  ];
  const parts: string[] = [];
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        parts.push(fs.readFileSync(p, 'utf8'));
      }
    } catch { /* ignore */ }
  }
  if (parts.length > 0) {
    context.globalState.update('k-horizon-repo-instructions', parts.join('\n\n---\n\n'));
    console.log(`K-Horizon: Loaded repo instructions (${parts.length} file(s)).`);
  }
}

async function syncCodebaseIndex(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('k-horizon');
  const embeddingProvider = config.get<string>('embeddingProvider', 'AICredits');
  const embeddingApiKey = config.get<string>('embeddingApiKey', '');
  const aicreditsKey = config.get<string>('aicreditsApiKey', '');

  const requiresEmbeddingKey = !['Ollama'].includes(embeddingProvider);
  const hasEmbeddingKey = embeddingProvider === 'AICredits'
    ? !!(embeddingApiKey || aicreditsKey)
    : !!embeddingApiKey;

  if (requiresEmbeddingKey && !hasEmbeddingKey) {
    const settingName = embeddingProvider === 'AICredits'
      ? 'embeddingApiKey or aicreditsApiKey'
      : 'embeddingApiKey';
    vscode.window.setStatusBarMessage(`RAG: Set ${settingName} to enable ${embeddingProvider} vector search`, 8000);
    return;
  }

  // Probe whether a usable connection string exists (either via config or
  // SecretStorage). If neither is set we surface a clear status-bar hint
  // instead of letting the indexing loop silently fail.
  const configConnString = config.get<string>('supabaseConnectionString', '');
  let secretConnString = '';
  try {
    secretConnString = (await context.secrets.get('k-horizon.supabaseConnectionString')) || '';
  } catch { /* ignore */ }
  if (!configConnString && !secretConnString) {
    vscode.window.setStatusBarMessage(
      '$(database) K-Horizon RAG: Set Supabase connection string (Cmd Palette > "K-Horizon: Set Supabase Connection String")',
      12000
    );
    return;
  }

  const indexingStatus = vscode.window.setStatusBarMessage('$(sync~spin) K-Horizon: Indexing workspace vector database...', 10000);
  try {
    const fs = require('fs');
    const files = await vscode.workspace.findFiles(
      '**/*',
      '**/{node_modules,.git,dist,out,build,.next,bin,obj,vendor,package-lock.json}/**'
    );

    // Get DB files to avoid checking files not present in DB
    let dbFiles: Set<string> = new Set();
    try {
      const pool = await DBClient.initialize();
      const dbRes = await pool.query('SELECT DISTINCT file_path FROM code_chunks');
      dbRes.rows.forEach(r => dbFiles.add(r.file_path));
    } catch (dbErr: any) {
      // Most common cause: connection string not yet wired up to SecretStorage.
      console.error('Failed to query existing files from DB:', dbErr);
      vscode.window.setStatusBarMessage(
        `$(error) K-Horizon RAG: Database unreachable — ${dbErr.message || dbErr.code || 'unknown error'}`,
        10000
      );
      return;
    }

    const mtimes = context.workspaceState.get<Record<string, number>>('indexedFilesMtimes') || {};

    let indexedCount = 0;
    for (const file of files) {
      try {
        const filePath = file.fsPath;
        if (!shouldIndexFile(filePath)) {
          continue;
        }
        const currentMtime = fs.statSync(filePath).mtimeMs;
        
        // Skip if file exists in DB AND is registered in mtimes AND mtimes matches
        if (dbFiles.has(filePath) && mtimes[filePath] && mtimes[filePath] === currentMtime) {
          continue;
        }

        const doc = await vscode.workspace.openTextDocument(file);
        const rel = vscode.workspace.asRelativePath(file);
        await RAGService.indexFile(filePath, rel, doc.getText());
        mtimes[filePath] = currentMtime;
        indexedCount++;
      } catch (e) {
        // Skip binary files
      }
    }

    // Purge stale DB entries for files that no longer exist in the workspace.
    // This handles files deleted while the extension was not running or missed
    // by the real-time file watcher.
    const workspaceFilePaths = new Set(files.map(f => f.fsPath));
    const staleFiles = Array.from(dbFiles).filter(dbPath => !workspaceFilePaths.has(dbPath));
    let purgedCount = 0;
    for (const staleFile of staleFiles) {
      try {
        await RAGService.deleteFileFromIndex(staleFile);
        delete mtimes[staleFile];
        purgedCount++;
      } catch (e) {
        console.error(`Failed to purge stale file ${staleFile} from index:`, e);
      }
    }
    if (purgedCount > 0) {
      console.log(`K-Horizon RAG: Purged ${purgedCount} stale file(s) from vector index.`);
    }

    await context.workspaceState.update('indexedFilesMtimes', mtimes);
    
    if (indexedCount > 0 || purgedCount > 0) {
      vscode.window.setStatusBarMessage(`$(check) K-Horizon RAG: Indexed ${indexedCount} file(s), purged ${purgedCount} stale file(s)`, 5000);
    } else {
      vscode.window.setStatusBarMessage(`$(check) K-Horizon RAG: Vector index is up-to-date`, 5000);
    }
  } catch (err: any) {
    console.error('Workspace index sync failed:', err);
  } finally {
    indexingStatus.dispose();
  }
}

function updateStatusBar() {
  const config = vscode.workspace.getConfiguration('k-horizon');
  const autocompleteEnabled = config.get<boolean>('enableAutocomplete', true);
  const provider = config.get<string>('provider', 'Gemini');

  if (autocompleteEnabled) {
    statusBarItem.text = `$(rocket) K-Horizon: ${provider}`;
    statusBarItem.tooltip = 'K-Horizon AI is Active. Click to Disable Autocomplete.';
    statusBarItem.color = new vscode.ThemeColor('statusBarItem.activeForeground');
  } else {
    statusBarItem.text = `$(circle-slash) K-Horizon: Off`;
    statusBarItem.tooltip = 'K-Horizon Autocomplete is Off. Click to Enable.';
    statusBarItem.color = undefined;
  }
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
  DBClient.disconnect();
  MCPManager.stopAllServers();
}

export function shouldIndexFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  const binaryExtensions = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.tgz', '.rar',
    '.mp4', '.mp3', '.wav', '.avi', '.mov', '.flac', '.woff', '.woff2', '.ttf', '.eot', '.vsix',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.db', '.sqlite', '.sqlite3', '.pyc', '.class'
  ]);
  if (binaryExtensions.has(ext)) return false;

  const baseName = path.basename(filePath).toLowerCase();
  const excludedNames = new Set([
    'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
    '.ds_store', 'thumbs.db', '.gitignore', '.gitattributes'
  ]);
  if (excludedNames.has(baseName)) return false;

  try {
    const stats = fs.statSync(filePath);
    if (stats.size > 1024 * 1024) { // 1MB limit
      return false;
    }
  } catch {
    return false;
  }

  return true;
}
