import * as vscode from 'vscode';
import { AIService } from './ai-service';
import { ContextManager } from './context-manager';
import { ChatMessage, AgentProfile } from './types';
import { DBClient } from './db-client';
import { RAGService } from './rag-service';
import { ToolManager } from './tool-manager';
import { createAgentGraph } from './agent-graph';
import { DiffHandler } from './diff-handler';
import { MCPManager } from './mcp-manager';
import { AgentTrace } from './agent-trace';
import { detectVerificationCommands } from './verification-commands';
import { MessageBroker } from './webview-handlers/message-broker';
import { registerChatHandlers } from './webview-handlers/chat-handlers';
import { registerSessionHandlers } from './webview-handlers/session-handlers';
import { registerFileHandlers } from './webview-handlers/file-handlers';
import { registerDiffHandlers } from './webview-handlers/diff-handlers';
import { registerSettingsHandlers } from './webview-handlers/settings-handlers';
import { registerMcpHandlers } from './webview-handlers/mcp-handlers';
import { registerToolHandlers } from './webview-handlers/tool-handlers';
import { registerLearningHandlers } from './webview-handlers/learning-handlers';
import { AgentLearningManager } from './learning-manager';
import { dispatchSubagent, resolveSkillsForSubagent } from './subagents/registry';
import { renderSkillsBlock } from './skills/skill-catalog';
import { pickExemplar, loadExemplar } from './examples/index';
import { ASTParser } from './ast-parser';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'k-horizon-chat-view';
  private _view?: vscode.WebviewView;
  private chatHistory: ChatMessage[] = [];
  // Persisted in globalState so the active session survives VS Code restarts
  // and sidebar panel hide/show cycles.
  private activeSessionId: string = 'default';
  private approvalResolvers = new Map<string, (approved: boolean) => void>();
  private isAgentRunning = false;
  private _extensionUri: vscode.Uri;
  private agentProfiles: AgentProfile[] = [];
  private toolDebugResolver: ((response: { approved: boolean; arguments?: Record<string, string>; skipped?: boolean; mocked?: boolean; mockValue?: string }) => void) | undefined = undefined;
  private checklistResolver: ((response: any[] | null) => void) | undefined = undefined;

  private activeFileHistory: string[] = [];

  constructor(private readonly _context: vscode.ExtensionContext) {
    this._extensionUri = _context.extensionUri;
    // Load custom agent profiles from globalState
    this.agentProfiles = _context.globalState.get<AgentProfile[]>('k-horizon-agent-profiles', []);
    // Restore the last-active session ID so the sidebar opens on the same
    // chat the user was looking at before reload/VS Code restart.
    const persistedSession = _context.globalState.get<string>('k-horizon-active-session-id');
    if (persistedSession) {
      this.activeSessionId = persistedSession;
    }

    // Track recently focused files
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && editor.document.uri.scheme === 'file') {
        const fsPath = editor.document.uri.fsPath;
        this.activeFileHistory = [fsPath, ...this.activeFileHistory.filter(p => p !== fsPath)].slice(0, 5);
      }
    }, null, _context.subscriptions);

    // Seed initial active editor if open
    const initialEditor = vscode.window.activeTextEditor;
    if (initialEditor && initialEditor.document.uri.scheme === 'file') {
      this.activeFileHistory.push(initialEditor.document.uri.fsPath);
    }
  }

  /**
   * Updates the active session ID and persists it to globalState so the
   * same chat re-opens on the next sidebar mount.
   */
  public async setActiveSessionId(sessionId: string): Promise<void> {
    this.activeSessionId = sessionId;
    await this._context.globalState.update('k-horizon-active-session-id', sessionId);
  }

  /** Returns the current active session ID. */
  public getActiveSessionId(): string {
    return this.activeSessionId;
  }

  /** Sends a message to the webview panel. */
  public postMessage(message: any): void {
    this._view?.webview.postMessage(message);
  }

  /** Returns the current workspace root path. */
  public getWorkspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  }

  /** Resolves a pending tool-debug approval prompt. */
  public resolveToolDebug(response: { approved: boolean; arguments?: Record<string, string>; skipped?: boolean; mocked?: boolean; mockValue?: string }): void {
    if (this.toolDebugResolver) {
      this.toolDebugResolver(response);
      this.toolDebugResolver = undefined;
    }
  }

  /** Resolves a pending checklist approval prompt. */
  public resolveChecklist(approvedCalls: any[] | null): void {
    if (this.checklistResolver) {
      this.checklistResolver(approvedCalls);
      this.checklistResolver = undefined;
    }
  }

  /** Persists agent profiles to globalState. */
  public async saveAgentProfiles(profiles: AgentProfile[]): Promise<void> {
    this.agentProfiles = profiles;
    await this._context.globalState.update('k-horizon-agent-profiles', this.agentProfiles);
    this.sendAgentProfiles();
  }

  private detectVerificationCommands(workspaceRoot: string): { compileCommand: string; testCommand: string | null } {
    return detectVerificationCommands(workspaceRoot);
  }

  // Resolve webview view, wire message handlers, and attach disposal-aware listeners
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    // Allow scripts and load local assets safely
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // --- Message Broker: dispatch webview messages to domain handlers ---
    const broker = new MessageBroker();
    registerChatHandlers(broker, this);
    registerSessionHandlers(broker, this);
    registerFileHandlers(broker, this);
    registerDiffHandlers(broker, this);
    registerSettingsHandlers(broker, this);
    registerMcpHandlers(broker, this);
    registerToolHandlers(broker, this);
    registerLearningHandlers(broker, this);

    webviewView.webview.onDidReceiveMessage((data) => broker.dispatch(data));

    // Notify files list updates when focus changes
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    fileWatcher.onDidCreate((uri) => {
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
      this.sendWorkspaceFiles();
    });
    fileWatcher.onDidDelete((uri) => {
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
      this.sendWorkspaceFiles();
    });

    // Listen for settings configuration updates in VS Code
    const configListener = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('k-horizon')) {
        this.sendSettings();
      }
    });

    webviewView.onDidDispose(() => {
      fileWatcher.dispose();
      configListener.dispose();
    });
  }

  /**
   * Initializes a new session.
   */
  public async newChat() {
    const newId = 'session_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();
    await this.setActiveSessionId(newId);
    this.chatHistory = [];
    this.activeFileHistory = [];
    ToolManager.resetWebSearchCount();
    if (this._view) {
      this._view.webview.postMessage({ type: 'clearChat' });
    }
  }

  /**
   * Loads past chat sessions from the database to populate the drawer list.
   */
  public async loadChatSessions() {
    if (!this._view) return;
    try {
      const pool = await DBClient.initialize();
      // Select the first message of each session as the title, but order sessions by their last active timestamp DESC
      const result = await pool.query(`
        SELECT session_id, MAX(timestamp) as last_activity, 
               (SELECT content FROM chat_history h2 WHERE h2.session_id = h.session_id ORDER BY timestamp ASC LIMIT 1) as content,
               (SELECT session_title FROM chat_history h3 WHERE h3.session_id = h.session_id ORDER BY timestamp ASC LIMIT 1) as session_title
        FROM chat_history h
        GROUP BY session_id
        ORDER BY last_activity DESC
      `);

      const sessions = result.rows.map(row => {
        let title = row.session_title || 'New Conversation';
        if (title === 'New Conversation' && row.content) {
          // Extract user message query if it contains RAG tags
          let cleanContent = row.content;
          const userIndex = row.content.indexOf('User Request:\n');
          if (userIndex !== -1) {
            cleanContent = row.content.substring(userIndex + 13);
          }
          title = cleanContent.trim().substring(0, 30) + (cleanContent.length > 30 ? '...' : '');
        }
        return {
          id: row.session_id,
          title: title,
          active: row.session_id === this.activeSessionId
        };
      });

      this._view.webview.postMessage({
        type: 'chatSessions',
        sessions: sessions
      });
    } catch (e) {
      console.error('Failed to load sessions list:', e);
    }
  }

  public async deleteSession(sessionId: string) {
    try {
      const pool = await DBClient.initialize();
      await pool.query('DELETE FROM chat_history WHERE session_id = $1', [sessionId]);
      
      if (this.activeSessionId === sessionId) {
        // If deleted the active session, switch to the next most recent one, or newChat if none
        const nextSessionRes = await pool.query('SELECT session_id FROM chat_history ORDER BY timestamp DESC LIMIT 1');
        if (nextSessionRes.rows.length > 0) {
          await this.setActiveSessionId(nextSessionRes.rows[0].session_id);
          await this.loadChatHistoryFromDB();
        } else {
          await this.newChat();
        }
      }
      
      // Refresh the session list in the drawer
      await this.loadChatSessions();
    } catch (e) {
      console.error('Failed to delete chat session:', e);
    }
  }

  /**
   * Switches to a selected chat session and loads its history.
   */
  public async switchSession(sessionId: string) {
    await this.setActiveSessionId(sessionId);
    await this.loadChatHistoryFromDB();
  }

  /**
   * Prunes the current chat database to save tokens, leaving only the final turn.
   */
  public async compactSession() {
    try {
      const pool = await DBClient.initialize();
      // Keep only the last 2 messages for the current session in database
      await pool.query(`
        DELETE FROM chat_history 
        WHERE session_id = $1 
        AND id NOT IN (
          SELECT id FROM chat_history 
          WHERE session_id = $1 
          ORDER BY timestamp DESC 
          LIMIT 2
        )
      `, [this.activeSessionId]);

      // Reload compacted history
      await this.loadChatHistoryFromDB();

      if (this._view) {
        this._view.webview.postMessage({ type: 'sessionCompacted' });
      }
    } catch (e) {
      console.error('Failed to compact session:', e);
    }
  }

  /**
   * Applies a code block directly into the active editor.
   */
  public applyCodeBlock(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active text editor to insert code block.');
      return;
    }

    editor.edit(editBuilder => {
      // Replace selection or type at cursor
      editBuilder.replace(editor.selection, code);
    }).then(success => {
      if (success) {
        vscode.window.showInformationMessage('Code block applied to editor selection.');
      }
    });
  }

  /**
   * Loads chat history for the active session from Supabase.
   */
  public async loadChatHistoryFromDB() {
    if (!this._view) return;
    try {
      const pool = await DBClient.initialize();
      const result = await pool.query(
        'SELECT role, content, timestamp FROM chat_history WHERE session_id = $1 ORDER BY timestamp ASC LIMIT 200',
        [this.activeSessionId]
      );

      this.chatHistory = result.rows.map(row => ({
        role: row.role as 'user' | 'assistant' | 'system',
        content: row.content,
        timestamp: parseFloat(row.timestamp)
      }));

      // Post messages payload back to Webview
      this._view.webview.postMessage({
        type: 'chatHistory',
        history: this.chatHistory.map(m => ({
          role: m.role,
          content: m.content
        }))
      });
    } catch (e) {
      console.error('Failed to load chat history:', e);
    }
  }

  /**
   * Clears the active chat session history in database and memory.
   */
  public async clearHistory() {
    this.chatHistory = [];
    this.activeFileHistory = [];
    try {
      const pool = await DBClient.initialize();
      await pool.query('DELETE FROM chat_history WHERE session_id = $1', [this.activeSessionId]);
    } catch (e) {
      console.error('Failed to wipe chat history:', e);
    }

    if (this._view) {
      this._view.webview.postMessage({ type: 'clearChat' });
    }
  }

  public async sendWorkspaceFiles() {
    if (!this._view) return;
    try {
      const files = await ContextManager.getWorkspaceFiles(2000);
      this._view.webview.postMessage({
        type: 'workspaceFiles',
        files: files
      });
    } catch (e) {
      console.error('Failed to send workspace files:', e);
    }
  }

  public sendAgentProfiles() {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'agentProfiles',
        profiles: this.agentProfiles
      });
    }
  }

  public async sendSettings() {
    if (!this._view) return;
    const settings = AIService.getSettings();

    let vscodeLMModels: { name: string, modelId: string, provider: string }[] = [];
    try {
      if (vscode.lm && typeof vscode.lm.selectChatModels === 'function') {
        const models = await vscode.lm.selectChatModels({});
        vscodeLMModels = models.map(m => ({
          name: `${m.name || m.id} (${m.vendor})`,
          modelId: m.id,
          provider: 'Copilot'
        }));
      }
    } catch (e) {
      console.error('Failed to query vscode.lm models:', e);
    }

    this._view.webview.postMessage({
      type: 'settingsUpdate',
      provider: settings.provider,
      chatModel: settings.chatModel,
      customModels: settings.customModels || [],
      vscodeLMModels: vscodeLMModels
    });
  }

  public async sendWorkspaceHealth() {
    if (!this._view) return;

    const settings = AIService.getSettings();
    const config = vscode.workspace.getConfiguration('k-horizon');
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let workspaceFileCount = 0;
    let diagnosticCount = 0;
    let errorCount = 0;
    let warningCount = 0;
    let gitAvailable = false;

    try {
      const files = await ContextManager.getWorkspaceFiles(2000);
      workspaceFileCount = files.length;
    } catch (e) {
      console.error('Failed to count workspace files for health panel:', e);
    }

    try {
      for (const [, diagnostics] of vscode.languages.getDiagnostics()) {
        diagnosticCount += diagnostics.length;
        errorCount += diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
        warningCount += diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Warning).length;
      }
    } catch (e) {
      console.error('Failed to count diagnostics for health panel:', e);
    }

    try {
      gitAvailable = !!workspaceRoot && fs.existsSync(path.join(workspaceRoot, '.git'));
    } catch (e) {
      gitAvailable = false;
    }

    this._view.webview.postMessage({
      type: 'workspaceHealth',
      health: {
        provider: settings.provider,
        chatModel: settings.chatModel,
        autocompleteEnabled: settings.enableAutocomplete,
        maxContextTokens: settings.maxContextTokens,
        hasApiKey: !!settings.apiKey || settings.provider === 'Ollama' || settings.provider === 'Copilot',
        hasSupabaseConnection: !!config.get<string>('supabaseConnectionString', ''),
        hasEmbeddingKey: !!config.get<string>('aicreditsApiKey', ''),
        workspaceFileCount,
        diagnosticCount,
        errorCount,
        warningCount,
        gitAvailable,
        mcpServers: MCPManager.getServersStatus()
      }
    });
  }

  public async updateActiveModelInSettings(modelId: string, provider: string) {
    try {
      const config = vscode.workspace.getConfiguration('k-horizon');
      await config.update('provider', provider, vscode.ConfigurationTarget.Global);
      await config.update('chatModel', modelId, vscode.ConfigurationTarget.Global);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to update active model configuration: ${e.message}`);
    }
  }

  public async handleOpenFilePicker() {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Add to Chat Context',
      filters: {
        'All Files': ['*']
      }
    });

    if (files && files.length > 0) {
      const fileData = [];
      for (const fileUri of files) {
        const relativePath = vscode.workspace.asRelativePath(fileUri);
        fileData.push({
          filePath: fileUri.fsPath,
          relativePath: relativePath
        });
      }
      this._view?.webview.postMessage({
        type: 'addReferencedFiles',
        files: fileData
      });
    }
  }

  public insertTerminal(code: string) {
    const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('K-Horizon Terminal');
    terminal.sendText(code, false);
    terminal.show();
  }

  public insertCode(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.edit((editBuilder) => {
        editBuilder.insert(editor.selection.active, code);
      });
    } else {
      vscode.window.showWarningMessage('No active editor found to insert code.');
    }
  }

  public async createNewFile(code: string, language: string) {
    try {
      const document = await vscode.workspace.openTextDocument({
        content: code,
        language: language || 'plaintext'
      });
      await vscode.window.showTextDocument(document);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to create new file: ${e.message}`);
    }
  }

  public handleToolApprovalResponse(toolCallId: string, approved: boolean) {
    const resolver = this.approvalResolvers.get(toolCallId);
    if (resolver) {
      resolver(approved);
      this.approvalResolvers.delete(toolCallId);
    }
  }

  public cancelAgent() {
    this.isAgentRunning = false;
    ToolManager.abortAllProcesses();
    for (const [, resolve] of this.approvalResolvers.entries()) {
      resolve(false);
    }
    this.approvalResolvers.clear();
  }

  /**
   * Helper: Requests tool approval from the webview UI.
   * Used by the LangGraph executeTools node via the state callback.
   */
  private requestToolApproval(
    callId: string,
    _call: any,
    isStepMode: boolean
  ): Promise<{ approved: boolean; arguments?: Record<string, string>; skipped?: boolean; mocked?: boolean; mockValue?: string }> {
    return new Promise((resolve) => {
      if (isStepMode) {
        this.toolDebugResolver = resolve;
      } else {
        this.approvalResolvers.set(callId, (approved: boolean) => {
          resolve({ approved });
        });
      }
    });
  }

  private requestToolChecklist(
    calls: any[]
  ): Promise<any[] | null> {
    return new Promise((resolve) => {
      this.checklistResolver = resolve;
    });
  }

  public async openFile(filePath: string) {
    try {
      let uri: vscode.Uri;
      if (path.isAbsolute(filePath)) {
        uri = vscode.Uri.file(filePath);
      } else {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        uri = vscode.Uri.file(path.join(rootPath, filePath));
      }
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to open file: ${e.message}`);
    }
  }

  public async viewSidebarDiff(name: string, args: any) {
    try {
      const filePath = args.file_path;
      if (!filePath) return;
      const absolutePath = ToolManager.getAbsolutePath(filePath);
      const fileExists = fs.existsSync(absolutePath);
      let originalContent = '';
      if (fileExists) {
        originalContent = fs.readFileSync(absolutePath, 'utf8');
      }

      let proposedContent = originalContent;
      if (name === 'write_file') {
        proposedContent = args.content || '';
      } else if (name === 'edit_file') {
        const editResult = ToolManager.applyFlexibleReplacement(
          originalContent,
          args.target_content || '',
          args.replacement_content || ''
        );
        if (editResult) {
          proposedContent = editResult.content;
        } else {
          vscode.window.showErrorMessage('Diff Error: Could not locate target content inside file, even with whitespace-tolerant matching.');
          return;
        }
      }

      const tempDir = os.tmpdir();
      const randomId = Math.random().toString(36).substring(7);
      const baseName = path.basename(filePath);
      const tempOrig = path.join(tempDir, `k_horizon_orig_${randomId}_${baseName}`);
      const tempProp = path.join(tempDir, `k_horizon_prop_${randomId}_${baseName}`);

      fs.writeFileSync(tempOrig, originalContent, 'utf8');
      fs.writeFileSync(tempProp, proposedContent, 'utf8');

      vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(tempOrig),
        vscode.Uri.file(tempProp),
        `${baseName} (Sidebar Proposed Changes)`
      );
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to open sidebar diff: ${e.message}`);
    }
  }

  public async handleRollback() {
    const pool = await DBClient.initialize();
    try {
      const lastUserRes = await pool.query(
        `SELECT MAX(timestamp) as max_time FROM chat_history WHERE session_id = $1 AND role = 'user'`,
        [this.activeSessionId]
      );
      const maxTime = lastUserRes.rows[0]?.max_time;
      if (maxTime) {
        await pool.query(
          `DELETE FROM chat_history WHERE session_id = $1 AND timestamp >= $2`,
          [this.activeSessionId, maxTime]
        );
        vscode.window.showInformationMessage('Chat rolled back to the last user message.');
      }
      await this.loadChatHistoryFromDB();
    } catch (e: any) {
      vscode.window.showErrorMessage(`Rollback error: ${e.message}`);
    }
  }

  /**
   * Prepares context files and chat records, and streams LLM output.
   */
  public async handleUserMessage(
    prompt: string,
    referencedPaths: string[],
    _useWorkspaceContext: boolean,
    _autoApprove: boolean = true,
    role: string = 'developer',
    _autoCompile: boolean = false,
    pinnedPaths: string[] = [],
    _autoTest: boolean = false,
    _stepDebug: boolean = false,
    isSplitScreen: boolean = false,
    modelId2: string | null = null,
    provider2: string | null = null
  ) {
    if (!this._view) return;

    const config = vscode.workspace.getConfiguration('k-horizon');
    const useWorkspaceContext = config.get<boolean>('useWorkspaceContext', true);
    const autoApprove = config.get<boolean>('autoApprove', true);
    const autoCompile = config.get<boolean>('autoCompile', false);
    const autoTest = config.get<boolean>('autoTest', false);
    const stepDebug = config.get<boolean>('stepDebug', false);

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    try {
      // Build session title from the first query (limited to 30 chars)
      const sessionTitle = prompt.substring(0, 30) + (prompt.length > 30 ? '...' : '');

      // Save user prompt to Supabase
      const pool = await DBClient.initialize();

      // Intercept /help slash command for instant responsive help card
      if (prompt.trim() === '/help') {
        this._view.webview.postMessage({ type: 'streamStart' });
        const helpContent = `### K-HORIZON AI Help & Commands

Welcome to **K-HORIZON**, a powerful token-efficient agentic coding assistant!

Here are the available slash commands you can use in the chat:
- **/explain** - Analyzes the active file or selected code and explains it step-by-step.
- **/tests** - Generates comprehensive unit tests for the active file or selected code.
- **/fix** - Reviews the active code and compilation diagnostics to identify and fix errors.
- **/refactor** - Suggests design pattern and readability refactoring for the active code.
- **/document** - Automatically adds JSDoc comments or docstrings to functions and classes.
- **/clear** - Wipes the chat history for the active session.

**Key Features:**
1. **Context Mentions (\`@\`)**: Type \`@\` in the chat box to search and attach specific files to your prompt context.
2. **Pinned Files**: Click the pin icon on files in your workspace or use the file picker to keep critical files permanently in context.
3. **Compare Mode**: Click the split-window icon in the header to run two models in parallel and compare their responses side-by-side.
4. **Workspace Composer (Ctrl+Shift+I)**: Open a multi-file workspace-wide editing panel with search/replace diff previews before changes are applied.
5. **Auto-Healing Loops**:
   - Check **Approve** (auto-approve) to let the agent execute actions autonomously.
   - Run compilation checking (Auto-Compile) or test runs (Auto-Test) and let the AI self-heal any failed runs up to 3 times automatically.
`;
        this._view.webview.postMessage({ type: 'streamToken', token: helpContent });
        this._view.webview.postMessage({ type: 'streamEnd' });

        try {
          await pool.query(
            `INSERT INTO chat_history (role, content, timestamp, session_id, session_title)
             VALUES ($1, $2, $3, $4, $5)`,
            ['user', '/help', Date.now(), this.activeSessionId, 'Help Command']
          );
          await pool.query(
            `INSERT INTO chat_history (role, content, timestamp, session_id, session_title)
             VALUES ($1, $2, $3, $4, $5)`,
            ['assistant', helpContent, Date.now(), this.activeSessionId, 'Help Command']
          );
        } catch (dbErr) {
          console.error('Failed to save help command to DB:', dbErr);
        }
        this.chatHistory.push({ role: 'user', content: '/help', timestamp: Date.now() });
        this.chatHistory.push({ role: 'assistant', content: helpContent, timestamp: Date.now() });
        return;
      }

      // /clear — wipe the active session's history
      if (prompt.trim() === '/clear') {
        await this.clearHistory();
        return;
      }

      // /explain, /tests, /fix, /refactor, /document — operate on the active editor
      const slashCommandMatch = prompt.trim().match(/^\/(explain|tests|fix|refactor|document)\b\s*(.*)/);
      if (slashCommandMatch) {
        const slashCmd = slashCommandMatch[1];
        const trailingText = slashCommandMatch[2] || '';
        const active = ContextManager.getActiveEditorContext();
        if (!active || !active.selectionText) {
          this._view.webview.postMessage({
            type: 'streamError',
            error: `/${slashCmd} requires a code selection or active file with content.`,
          });
          return;
        }

        const slashPrompts: Record<string, string> = {
          explain: `Please explain its functionality step-by-step.`,
          tests: `Please generate comprehensive unit tests.`,
          fix: `Please review and fix any compilation or logic errors.`,
          refactor: `Please refactor the following code for readability and design.`,
          document: `Please add JSDoc/docstring comments to all functions and classes.`,
        };

        // Re-route the prompt so the rest of the pipeline (tool calls, RAG, etc.) just works
        prompt = `${slashPrompts[slashCmd]}\n\n${trailingText}`.trim();
        role = slashCmd === 'tests' ? 'tester'
             : slashCmd === 'fix' ? 'developer'
             : slashCmd === 'refactor' ? 'refactorer'
             : slashCmd === 'document' ? 'developer'
             : 'developer';

        // Ensure the active editor content is in context
        if (!referencedPaths.includes(active.filePath)) {
          referencedPaths.push(active.filePath);
        }
      }

      // Automatically align agent role based on slash commands
      if (prompt.includes('explain its functionality step-by-step')) {
        role = 'developer';
      } else if (prompt.includes('generate comprehensive unit tests')) {
        role = 'tester';
      } else if (prompt.includes('refactor the following code')) {
        role = 'refactorer';
      }

      const settings = AIService.getSettings();
      const tokenBudget = settings.maxContextTokens || 131000;
      let currentTokenCount = 0;
      let contextContent = '';
      const referencesList: { filePath: string, relativePath: string }[] = [];

      const addContextBlock = (header: string, contentText: string, filePath?: string, relativePath?: string) => {
        const blockText = `${header}\n\`\`\`\n${contentText}\n\`\`\`\n\n`;
        const blockTokens = AIService.estimateTokens(blockText);
        
        if (currentTokenCount + blockTokens < tokenBudget) {
          contextContent += blockText;
          currentTokenCount += blockTokens;
          if (filePath && relativePath && !referencesList.some(r => r.filePath === filePath)) {
            referencesList.push({ filePath, relativePath });
          }
          return true;
        } else {
          const remainingTokens = tokenBudget - currentTokenCount;
          if (remainingTokens > 500) {
            const charLimit = remainingTokens * 4;
            const truncatedText = contentText.substring(0, charLimit) + `\n// ... [rest of file content truncated to fit token budget] ...`;
            contextContent += `${header} (Truncated to fit budget):\n\`\`\`\n${truncatedText}\n\`\`\`\n\n`;
            if (filePath && relativePath && !referencesList.some(r => r.filePath === filePath)) {
              referencesList.push({ filePath, relativePath });
            }
            currentTokenCount = tokenBudget;
          }
          return false;
        }
      };

      // Separate virtual paths from real paths
      const virtualPaths = referencedPaths.filter(p => p.startsWith('virtual:'));
      const realPaths = referencedPaths.filter(p => !p.startsWith('virtual:'));

      // Gather contents of selected files
      const selectedContextFiles = await ContextManager.resolveFileContents(realPaths);
      if (selectedContextFiles.length > 0) {
        for (const file of selectedContextFiles) {
          addContextBlock(`### Referenced File Context: \`${file.relativePath}\``, file.content || '', file.filePath, file.relativePath);
        }
      }

      // Resolve virtual path contexts dynamically
      for (const vp of virtualPaths) {
        if (vp === 'virtual:problems') {
          try {
            const allDiagnostics = vscode.languages.getDiagnostics();
            let problemsText = '';
            allDiagnostics.forEach(([uri, diagnostics]) => {
              if (diagnostics.length > 0) {
                const relPath = vscode.workspace.asRelativePath(uri);
                problemsText += `File: ${relPath}\n`;
                diagnostics.forEach(d => {
                  const severity = vscode.DiagnosticSeverity[d.severity] || 'Problem';
                  problemsText += `  * [${severity}] Line ${d.range.start.line + 1}: ${d.message}\n`;
                });
              }
            });
            if (problemsText) {
              addContextBlock(`### Workspace Compiler Diagnostics / Problems`, problemsText);
            } else {
              addContextBlock(`### Workspace Compiler Diagnostics / Problems`, 'No compiler errors or warnings found in the active workspace!');
            }
          } catch (e: any) {
            console.error('Failed to query diagnostics:', e);
          }
        } else if (vp === 'virtual:git-diff') {
          try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (workspaceRoot) {
              const execSync = require('child_process').execSync;
              const diffOutput = execSync('git diff HEAD', { cwd: workspaceRoot, encoding: 'utf8', timeout: 5000 });
              if (diffOutput && diffOutput.trim()) {
                addContextBlock(`### Workspace Git Diff (Uncommitted Changes)`, diffOutput);
              } else {
                addContextBlock(`### Workspace Git Diff (Uncommitted Changes)`, 'No uncommitted changes (git diff is empty).');
              }
            } else {
              addContextBlock(`### Workspace Git Diff (Uncommitted Changes)`, 'Error: No active workspace folder found.');
            }
          } catch (gitErr: any) {
            addContextBlock(`### Workspace Git Diff (Uncommitted Changes)`, `Error executing git diff: ${gitErr.message}\nEnsure git is initialized in this repository.`);
          }
        } else if (vp === 'virtual:workspace') {
          try {
            const allFiles = await ContextManager.getWorkspaceFiles(1000);
            let layoutDesc = '';
            allFiles.forEach(f => {
              layoutDesc += `- ${f.relativePath}\n`;
            });
            addContextBlock(`### Workspace Folder Layout Map`, layoutDesc || '(Workspace is empty)');
          } catch (wsErr: any) {
            console.error('Failed to query workspace files map:', wsErr);
          }
        }
      }

      // Gather contents of pinned files
      const pinnedContextFiles = await ContextManager.resolveFileContents(pinnedPaths);
      if (pinnedContextFiles.length > 0) {
        for (const file of pinnedContextFiles) {
          addContextBlock(`### Pinned File Context: \`${file.relativePath}\``, file.content || '', file.filePath, file.relativePath);
        }
      }

      // Detect simple conversational prompts / greetings to skip heavy file injection
      const cleanPrompt = prompt.trim().toLowerCase();
      const isConversational = cleanPrompt.length < 20 && 
        /^(hi|hello|hey|yo|greetings|help|clear|reset|thanks|thank you|bye|goodbye|ok|okay)\b/i.test(cleanPrompt);

      if (!isConversational) {
        // OPT-IN workspace folder map: only inject the full 1000-file layout when
        // the user has explicitly enabled `useWorkspaceContext`. Previously this was
        // injected unconditionally and then re-injected a second time when
        // `useWorkspaceContext` was checked, doubling the cost. We now also cap
        // the rendered list at 200 files so that very large repos don't blow the
        // token budget before the active editor file gets a chance to be included.
        if (useWorkspaceContext) {
          try {
            const allFiles = await ContextManager.getWorkspaceFiles(200);
            if (allFiles && allFiles.length > 0) {
              let layoutDesc = `### Workspace Folder Layout Map (capped at 200 files):\n`;
              allFiles.forEach(f => {
                layoutDesc += `- ${f.relativePath}\n`;
              });
              layoutDesc += `\n`;

              const layoutTokens = AIService.estimateTokens(layoutDesc);
              if (currentTokenCount + layoutTokens < tokenBudget) {
                contextContent += layoutDesc;
                currentTokenCount += layoutTokens;
              }
            }
          } catch (wsErr: any) {
            console.error('Failed to query default workspace layout map:', wsErr);
          }
        }

        // Semantic Vector RAG Search using pgvector if checked (only if aicreditsApiKey is set)
        if (useWorkspaceContext) {
          const config = vscode.workspace.getConfiguration('k-horizon');
          const apiKey = config.get<string>('aicreditsApiKey', '');
          if (apiKey) {
            const statusMessage = vscode.window.setStatusBarMessage('$(sync~spin) K-Horizon: Searching vector index...', 10000);
            try {
              const ragResult = await RAGService.retrieveContext(prompt, 5);
              if (ragResult.context) {
                const ragTokens = AIService.estimateTokens(ragResult.context);
                if (currentTokenCount + ragTokens < tokenBudget) {
                  contextContent += ragResult.context;
                  currentTokenCount += ragTokens;
                }
                for (const file of ragResult.files) {
                  if (!referencesList.some(r => r.filePath === file.filePath)) {
                    referencesList.push(file);
                  }
                }
              }
            } catch (ragErr: any) {
              console.error('RAG search failed:', ragErr);
            } finally {
              statusMessage.dispose();
            }
          }
        }

        // 1. Inject Active Editor Selection, Cursor, and Diagnostics Context
        const activeContext = ContextManager.getActiveEditorContext();
        if (activeContext) {
          let activeEditorDesc = `### Active Editor Context:\n`;
          activeEditorDesc += `- Active File: \`${activeContext.relativePath}\`\n`;
          activeEditorDesc += `- Line Range: lines ${activeContext.startLine} to ${activeContext.endLine}\n`;
          if (activeContext.selectionText) {
            activeEditorDesc += `- Highlighted Selection Code:\n\`\`\`\n${activeContext.selectionText}\n\`\`\`\n`;
          }
          if (activeContext.surroundingContext) {
            activeEditorDesc += `- Surrounding Context Code:\n\`\`\`\n${activeContext.surroundingContext}\n\`\`\`\n`;
          }

          // Live Editor Diagnostics for active file
          try {
            const diagnostics = vscode.languages.getDiagnostics(vscode.Uri.file(activeContext.filePath));
            if (diagnostics && diagnostics.length > 0) {
              activeEditorDesc += `- Live Linter/Compiler Problems:\n`;
              diagnostics.forEach(diag => {
                const severity = vscode.DiagnosticSeverity[diag.severity] || 'Problem';
                activeEditorDesc += `  * [${severity}] Line ${diag.range.start.line + 1}: ${diag.message}\n`;
              });
            }
          } catch (diagErr) {
            console.error("Failed to fetch live diagnostics for active file:", diagErr);
          }
          activeEditorDesc += `\n`;

          const descTokens = AIService.estimateTokens(activeEditorDesc);
          if (currentTokenCount + descTokens < tokenBudget) {
            contextContent += activeEditorDesc;
            currentTokenCount += descTokens;
          }
        }

        // 2. Inject recently opened file list (temporal context). Cap to 3 most
        // recent files so they don't crowd out the active editor file. Previously
        // the full history was appended with no cap.
        if (this.activeFileHistory.length > 0) {
          const recentFiles = this.activeFileHistory.slice(-3);
          let temporalDesc = `### Recently Opened/Focused Files (most recent 3):\n`;
          recentFiles.forEach(fsPath => {
            temporalDesc += `- \`${vscode.workspace.asRelativePath(vscode.Uri.file(fsPath))}\`\n`;
          });
          temporalDesc += `\n`;

          const tempTokens = AIService.estimateTokens(temporalDesc);
          if (currentTokenCount + tempTokens < tokenBudget) {
            contextContent += temporalDesc;
            currentTokenCount += tempTokens;
          }
        }

        // 3. Skip the second workspace file layout injection. Previously the same
        // 1000-file list was rendered twice (once unconditionally above and once
        // here when `useWorkspaceContext` was checked). The single opt-in injection
        // above is sufficient.

        // 4. Inject Active Editor File Content if not already explicitly referenced or pinned (summarized if large)
        if (activeContext && !referencedPaths.includes(activeContext.filePath) && !pinnedPaths.includes(activeContext.filePath)) {
          try {
            const resolved = await ContextManager.resolveFileContents([activeContext.filePath]);
            if (resolved.length > 0) {
              addContextBlock(`### Current Editor Active File Content: \`${activeContext.relativePath}\``, resolved[0].content || '', activeContext.filePath, activeContext.relativePath);
            }
          } catch (activeErr) {
            console.error("Failed to read active editor full file text:", activeErr);
          }
        }

        // 5. Inject other open editor tabs context (limited to at most 2 tabs,
// excluding build assets). Previously capped at 5 which consumed ~10k tokens
// before the user's actual file got a chance to be included.
        try {
          const openDocs = vscode.workspace.textDocuments.filter(doc => doc.uri.scheme === 'file');
          const docsToProcess = openDocs
            .filter(doc => {
              const fsPath = doc.uri.fsPath;
              const relPath = vscode.workspace.asRelativePath(doc.uri);
              const ext = path.extname(fsPath).toLowerCase();
              const isExcluded = 
                relPath.includes('node_modules') || 
                relPath.includes('.git') || 
                relPath.includes('dist') || 
                relPath.includes('out') ||
                relPath.includes('build') ||
                ['.vsix', '.map', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.pdf', '.zip'].includes(ext) ||
                relPath.endsWith('package-lock.json');
              return fsPath !== activeContext?.filePath && 
                     !referencedPaths.includes(fsPath) && 
                     !pinnedPaths.includes(fsPath) && 
                     !isExcluded;
            })
            .slice(0, 2);

          const docPaths = docsToProcess.map(doc => doc.uri.fsPath);
          if (docPaths.length > 0) {
            const resolvedDocs = await ContextManager.resolveFileContents(docPaths);
            for (const file of resolvedDocs) {
              addContextBlock(`### Open Editor Tab Content: \`${file.relativePath}\``, file.content || '');
            }
          }
        } catch (docsErr) {
          console.error("Failed to process open documents context:", docsErr);
        }
      }

      // Send referenced files list to webview to render accordion
      this._view.webview.postMessage({ type: 'referencesUsed', references: referencesList });

      // Build role profile prompt
      let rolePrompt = '';
      const customProfile = this.agentProfiles.find(p => p.key === role);
      if (customProfile) {
        rolePrompt = customProfile.systemPrompt;
      } else if (role === 'security') {
        rolePrompt = `You are K-HORIZON AI acting as a Security Specialist and Auditor.
Focus heavily on security:
- Scan for input injection, sanitization issues, and unsafe execution.
- Review dependency security, memory leaks, and buffer boundaries.
- Suggest secure coding patterns (e.g. prepared queries, encryption, input sanitization) for all modifications.`;
      } else if (role === 'tester') {
        rolePrompt = `You are K-HORIZON AI acting as a QA and Test Engineer.
Focus heavily on software verification:
- Suggest and write comprehensive unit and integration tests (e.g. using Jest, Mocha, Vitest).
- Identify edge cases, testing boundary conditions, mock objects, and negative test scenarios.
- Ensure all custom code is modular and easily testable.`;
      } else if (role === 'refactorer') {
        rolePrompt = `You are K-HORIZON AI acting as a Refactoring and Code Quality Expert.
Focus heavily on architecture and readability:
- Enforce DRY (Don't Repeat Yourself) and SOLID design principles.
- Optimize code structure, clean up dead code, and reduce cyclomatic complexity.
- Improve variable naming, separation of concerns, and modular decoupling.`;
      } else if (role === 'planner') {
        rolePrompt = `You are K-HORIZON AI acting as an Agentic Software Architect and Planner.
Your execution flow for any non-trivial task MUST follow these phases:
1. **Plan Phase**: Create an implementation plan file inside the \`.k-horizon\` directory named \`.k-horizon/implementation_plan.md\` describing the changes, files to touch, and verification steps. Use the \`write_file\` tool.
2. **Task Phase**: Create a task list file inside the \`.k-horizon\` directory named \`.k-horizon/task.md\` listing the TODO items. Use the \`write_file\` tool.
3. **Execute Phase**: Step through the tasks. For each task:
   - Perform the code change using \`write_file\`, \`edit_file\`, etc.
   - Update the task list file to check off completed items (\`[x]\`).
   - Run compilation or verification if appropriate.
4. **Walkthrough Phase**: Create a walkthrough file inside the \`.k-horizon\` directory named \`.k-horizon/walkthrough.md\` summarizing what was done and tested. Use the \`write_file\` tool.`;
      } else {
        rolePrompt = `You are K-HORIZON AI acting as a Principal Developer.
Focus on writing clean, efficient, production-ready code blocks directly with minimal conversational filler.
For any non-trivial or multi-file task, you MUST follow these phases:
1. **Understand Phase**: Analyze the user prompt, verify the workspace files and structure.
2. **Plan Phase**: Create an implementation plan inside the \`.k-horizon\` directory named \`.k-horizon/implementation_plan.md\` outlining the proposed changes, files to be created/modified, and verification strategy. Use the \`write_file\` tool.
3. **Task Phase**: Create a task list file inside the \`.k-horizon\` directory named \`.k-horizon/task.md\` to keep track of progress. Use the \`write_file\` tool.
4. **Execute Phase**: Implement the plan, checking off completed tasks in \`.k-horizon/task.md\` as you go.
5. **Walkthrough Phase**: Conclude by writing a walkthrough file inside the \`.k-horizon\` directory named \`.k-horizon/walkthrough.md\` summarizing the changes made, tests run, and validation results.`;
      }

      const now = new Date();
      const timeString = now.toString();
      const codingStandardsBlock = `

## CODING STANDARDS (MUST FOLLOW)

Apply these consistently across all code you write or edit:

- **TypeScript strict mode**: honor the project's tsconfig.json "strict" flag. Do not introduce \`any\`, \`@ts-ignore\`, or \`@ts-expect-error\` unless the existing codebase already uses them.
- **Naming**: \`PascalCase\` for types/classes, \`camelCase\` for variables/functions, \`UPPER_SNAKE_CASE\` for module-level constants, kebab-case for file names unless the project convention differs.
- **Imports**: ES module syntax (\`import\`/\`export\`). Order: 1) node builtins, 2) third-party packages, 3) workspace imports (blank line between groups). No default exports for shared utilities.
- **Async**: always \`await\` or explicitly return the Promise; never fire-and-forget without \`.catch\`.
- **Error handling**: typed error catches (\`catch (err: unknown)\` or specific subclass); never swallow errors silently. Surface actionable messages to the caller.
- **Side effects**: no top-level side effects in modules; main logic must live in exported functions.
- **Comments**: only when explaining WHY, not WHAT. No "// rest of code remains the same" placeholders. Always write complete, working code.
- **Test framework**: prefer the existing project's framework (vitest for this repo). New functions should include at least a smoke test if they have non-trivial logic.
- **Formatting**: 2-space indent, single quotes for strings, semicolons required, trailing commas in multi-line literals.

If the project you are editing already violates any of these rules, match the existing style rather than the standard.
`;

      let systemInstruction = `Current local date and time: ${timeString}.

${rolePrompt}
${codingStandardsBlock}
Rules:
1. Provide extremely concise explanations. Cut conversational filler.
2. For any file modifications (creating, writing, editing, or deleting files) or running commands, you MUST use the corresponding XML tool call format. Do not write markdown code blocks for file modifications.
3. Write clean, production-ready code and apply changes via tool calls directly rather than asking the user to copy/paste or write them manually.
4. When writing code snippets that are NOT meant to be written to files, specify the language in the markdown block (e.g. \`\`\`typescript).
5. Do NOT compromise on code quality or completeness to save tokens. Never use placeholders or comments like '// rest of code remains the same' to truncate code blocks. Always provide complete, working implementations in all code blocks and file edits.
6. Self-heal on transient failures (up to 3 retries per compile/test phase). After hitting the budget, summarize the blocker to the user instead of burning more turns. Analyze failure output, identify the corrected parameters or files, and output new tool calls to rectify the error. Never silently give up, but do recognize when manual user input is needed.
7. For any non-trivial or multi-file task, you MUST first understand the prompt, create \`.k-horizon/implementation_plan.md\`, track your progress with a \`.k-horizon/task.md\` list, and conclude by creating \`.k-horizon/walkthrough.md\` summarizing your work and verification results.
8. Keep looping in your autonomous execution loop. Do NOT stop or ask the user to run commands for you. You have full terminal and file execution capabilities. Sequentially execute all necessary tool calls (finding, creating, editing files, compilation checks, test runs) until the task is completely finished. Only output a final text summary without tool calls when everything is fully verified and complete.
9. Efficiency & Batching: To minimize response latency and reduce the time spent between commands, you are highly encouraged to output MULTIPLE tool calls within a single response turn whenever possible (e.g. writing/editing files and running compile in one go), rather than performing them one-by-one.
10. Tool Calls vs Conversational Responses: You MUST NOT output conversational text-only responses explaining what you plan to do, listing steps in markdown, or describing code changes. You MUST output the actual JSON tool call (see JSON contract below) to execute the actions immediately in the same turn. Never output a text-only explanation without tool calls unless the entire user task is 100% completed, fully verified, and you are summarizing the completed work. The legacy XML \`tool_call\` form is still parsed for backwards compatibility, but JSON is preferred.

JSON tool-call contract (always emit JSON, single call or array):
  Single call:
    {"name": "edit_file", "arguments": {"file_path": "src/x.ts", "target_content": "...", "replacement_content": "..." } }
  Multiple calls in one turn (array of objects):
    [
      {"name": "read_file", "arguments": {"file_path": "src/a.ts" } },
      {"name": "read_file", "arguments": {"file_path": "src/b.ts" } }
    ]
  Keys "name" and "arguments" are case-sensitive.
  "arguments" may be empty {} for parameter-less tools.
  Optional aliases "args" and "parameters" are accepted.
  See AGENTS.md §5 for the full contract.
11. **Verify Before Claiming Done**: After every \`write_file\` or \`edit_file\` call, follow up with \`verify_edit\` to read the file back from disk and check for new diagnostics. After any multi-file change, run the build/tests. Only claim a task is complete when those verifications actually pass — the run output must show success, not absence of errors.
12. **Edit Hygiene**: When \`edit_file\` returns "target not found", DO NOT guess a different target. Read the file first with \`read_file\`, then copy the EXACT bytes you want to replace into your next \`target_content\` argument.
13. **Visible Reasoning Summary**: Do not reveal private chain-of-thought. When useful, provide a short visible summary of your approach and verification status in normal assistant text after the work is complete.

You have access to the following tools to interact with the filesystem, run commands, and search the web:

1. List contents of a directory:
<tool_call name="list_dir">
  <directory>[optional relative or absolute path, defaults to .]</directory>
</tool_call>

2. Read file contents:
<tool_call name="read_file">
  <file_path>[relative or absolute file path]</file_path>
</tool_call>

3. Write/create file:
<tool_call name="write_file">
  <file_path>[relative or absolute file path]</file_path>
  <content>[file content text]</content>
</tool_call>

4. Edit file (Search & Replace specific text):
<tool_call name="edit_file">
  <file_path>[relative or absolute file path]</file_path>
  <target_content>[exact block of content to find and replace]</target_content>
  <replacement_content>[content to replace the target block with]</replacement_content>
</tool_call>

5. Delete file:
<tool_call name="delete_file">
  <file_path>[relative or absolute file path]</file_path>
</tool_call>

6. Grep search in files:
<tool_call name="grep_search">
  <query>[search text query]</query>
  <directory>[optional search directory, defaults to .]</directory>
</tool_call>

7. Search the web for information:
<tool_call name="web_search">
  <query>[web search query string]</query>
</tool_call>

8. Fetch text content from a web page:
<tool_call name="fetch_webpage">
  <url>[url to fetch, e.g. https://...]</url>
</tool_call>

9. Run command in terminal (captures output):
<tool_call name="run_command">
  <command>[shell command to run, e.g. npm run build]</command>
  <directory>[optional relative path to run the command in, e.g. portfolio; defaults to workspace root. DO NOT use cd or Set-Location in the command, use this parameter instead]</directory>
  <timeout_ms>[optional estimated timeout in milliseconds, e.g. 15000 (15s) or 120000 (2m); defaults to 60000]</timeout_ms>
</tool_call>

10. Get active editor file path, selection, and cursor context:
<tool_call name="get_active_editor_context">
</tool_call>

11. Get compiler & lint diagnostics (warnings/errors) in workspace or specific file:
<tool_call name="get_diagnostics">
  <file_path>[optional relative file path to query]</file_path>
</tool_call>

12. Search for symbols (classes, methods, variables, functions) in the workspace:
<tool_call name="search_workspace_symbols">
  <query>[symbol query string]</query>
</tool_call>

13. Find references to a symbol at a specific location:
<tool_call name="find_references">
  <file_path>[relative file path]</file_path>
  <line>[1-indexed line number]</line>
  <character>[0-indexed character index]</character>
</tool_call>

14. Find definitions for a symbol at a specific location:
<tool_call name="find_definitions">
  <file_path>[relative file path]</file_path>
  <line>[1-indexed line number]</line>
  <character>[0-indexed character index]</character>
</tool_call>

15. Show a VS Code information message/toast to the user:
<tool_call name="show_info_message">
  <message>[message text to display]</message>
</tool_call>

16. List installed non-system VS Code extensions:
<tool_call name="get_vscode_extensions">
</tool_call>

17. Send command to the active VS Code Terminal panel (runs visibly to the user):
<tool_call name="send_to_terminal">
  <command>[command to run, e.g. npm run dev or git status]</command>
  <terminal_name>[optional name of the terminal tab, defaults to "K-Horizon Terminal"]</terminal_name>
</tool_call>

18. Open a file side-by-side in a split editor layout:
<tool_call name="open_file_to_side">
  <file_path>[relative or absolute file path to open]</file_path>
</tool_call>

19. Preview raw HTML or an HTML file inside a split-editor webview:
<tool_call name="preview_html">
  <file_path>[optional path to an HTML file to load]</file_path>
  <html_content>[optional raw HTML string to display directly]</html_content>
</tool_call>

20. Execute any built-in VS Code command:
<tool_call name="execute_vscode_command">
  <command_id>[id of the VS Code command, e.g. editor.action.formatDocument]</command_id>
  <arguments_json>[optional JSON array of arguments for the command]</arguments_json>
</tool_call>

21. Search workspace files recursively matching a glob pattern:
<tool_call name="find_files">
  <pattern>[glob pattern to search, e.g. **/*.ts or src/**/*.js]</pattern>
</tool_call>

22. Get outline symbols (classes, functions, methods) from a file:
<tool_call name="get_file_outline">
  <file_path>[relative or absolute path to code file]</file_path>
</tool_call>

23. Get uncommitted git status changes in the repository:
<tool_call name="git_status">
</tool_call>

24. Get diff representation of active changes in the codebase:
<tool_call name="git_diff">
</tool_call>

25. Robust Web Scraping using Playwright (locates and uses system Chrome/Edge):
<tool_call name="web_scrape">
  <url>[url to scrape]</url>
  <selector>[optional container selector, defaults to body]</selector>
</tool_call>

26. Retrieve live developer documentation, API references, and coding templates for programming libraries and frameworks (backed by Context7 MCP — only fetches coding/SWE content from DevDocs, GitHub repos, MDN, open-source docs, and developer blogs):
<tool_call name="get_library_docs">
  <library_name>[name of library, e.g. react, express, tailwindcss, typescript]</library_name>
  <version>[optional version descriptor, e.g. latest, legacy, v18, v19, v3, v4]</version>
</tool_call>

## PROJECT SCAFFOLDING (CRITICAL — read before creating any new project)

When the user asks you to build a website, app, API, or any new project AND there is no \`package.json\` in the workspace root (or the target directory), you MUST follow this scaffolding sequence:

1. **If the workspace is empty or the target directory doesn't exist yet:**
   - Use \`<tool_call name="run_command"><command>npm init -y</command></tool_call>\` to create \`package.json\`.
   - If creating a framework project (React, Next.js, Vite, etc.), use the framework's CLI:
     - React: \`npx create-react-app .\` (or \`npm create vite@latest . -- --template react\`)
     - Next.js: \`npx create-next-app@latest .\`
     - Vite (vanilla/TS): \`npm create vite@latest . -- --template vanilla-ts\`
     - Express: \`npm init -y\` then \`npm install express\`
   - The \`<directory>\` parameter is NOT needed when scaffolding at workspace root.

2. **After \`package.json\` exists, install dependencies:**
   - \`npm install react react-dom\` (runtime deps)
   - \`npm install --save-dev typescript @types/react @types/react-dom\` (dev deps)
   - \`npm install -D tailwindcss postcss autoprefixer\` (if using Tailwind)

3. **Create config files with \`write_file\`:**
   - \`tsconfig.json\`, \`vite.config.ts\`, \`tailwind.config.js\`, \`postcss.config.js\`, etc.
   - Use \`get_library_docs\` to get the correct config templates if unsure.

4. **Create source files with \`write_file\`:**
   - \`index.html\`, \`src/main.tsx\`, \`src/App.tsx\`, \`src/index.css\`, etc.

5. **Verify the project builds:**
   - Run \`npm run build\` (or \`npm run dev\` to start dev server).

**IMPORTANT:** When scaffolding a new project, NEVER try to install dependencies BEFORE creating \`package.json\`. Always run \`npm init -y\` first. The \`run_command\` tool supports \`npm init\`, \`npm create\`, and \`npx create-*\` commands even when no \`package.json\` exists yet.

Instructions for Tool Calls:
- To call a tool, you MUST output the actual JSON tool call (see JSON contract in rule 10). Emitting JSON is required. The legacy XML format is only supported for compatibility.
- Self-Healing & Error Recovery: If a compilation command, test runner, or file edit tool execution fails, review the error log, use get_library_docs to double check templates/APIs, correct your parameters, and retry. Do not give up immediately.
- Directory Persistence & cd: Remember that the working directory is NOT persisted between separate run_command calls. Every tool call starts at the workspace root. DO NOT use cd or Set-Location commands. Always use the directory parameter to run commands in subdirectories.
- Custom Timeouts: Use the timeout_ms parameter in run_command to assign estimated runtimes for long commands, so that they abort gracefully and let you react to timeouts.`;

      let mcpToolsPrompt = '';
      const mcpTools = MCPManager.getAllTools();
      if (mcpTools.length > 0) {
        mcpToolsPrompt = `\n\nYou also have access to the following external MCP (Model Context Protocol) tools from connected servers:\n`;
        mcpTools.forEach((tool, index) => {
          mcpToolsPrompt += `\n${index + 27}. Call tool "${tool.name}" on server "${tool.serverName}" (${tool.description || 'no description'}):\n`;
          mcpToolsPrompt += `<tool_call name="mcp__${tool.serverName}__${tool.name}">\n`;
          if (tool.inputSchema && tool.inputSchema.properties) {
            Object.keys(tool.inputSchema.properties).forEach(propName => {
              const prop = tool.inputSchema.properties[propName];
              mcpToolsPrompt += `  <${propName}>[${prop.type}${prop.description ? ': ' + prop.description : ''}]</${propName}>\n`;
            });
          }
          mcpToolsPrompt += `</tool_call>\n`;
        });
      }
      systemInstruction += mcpToolsPrompt;

      // Reinforce XML tool calling for DeepSeek/Custom models
      const activeProvider = provider2 || settings.provider || '';
      const activeModel = modelId2 || settings.chatModel || '';
      if (activeProvider.toLowerCase() === 'custom' || activeModel.toLowerCase().includes('deepseek')) {
        systemInstruction += `\n\nCRITICAL WARNING: You MUST NOT use "<｜DSML｜_tool_call>", "<｜Action｜>", or any custom DeepSeek/Ollama delimiters for tool calling. You MUST output tool calls in the exact XML format specified below:
<tool_call name="tool_name">
  <param_name>value</param_name>
</tool_call>
Any other format is invalid and cannot be parsed.`;
      }

      // ── Inject subagent profile + RAG skills + few-shot exemplar ──
      const subagent = await dispatchSubagent(prompt);
      systemInstruction += `\n\n## Subagent Mode: ${subagent.label}\n${subagent.systemPrompt}`;

      const skills = resolveSkillsForSubagent(subagent, prompt);
      const skillsBlock = renderSkillsBlock(skills);
      if (skillsBlock) {
        systemInstruction += `\n\n${skillsBlock}`;
      }

      const exemplar = pickExemplar(prompt);
      if (exemplar) {
        const exemplarContent = loadExemplar(exemplar.category);
        if (exemplarContent) {
          systemInstruction += `\n\n## Gold-Standard Exemplar (follow this pattern)\n${exemplarContent}`;
        }
      }

      // ── Inject continuous agent learning rules ──
      const enableContinuousLearning = vscode.workspace.getConfiguration('k-horizon').get<boolean>('enableContinuousLearning', true);
      if (enableContinuousLearning) {
        const learningsPrompt = await AgentLearningManager.loadLearningsAsPrompt(workspaceRoot);
        if (learningsPrompt) {
          systemInstruction += `\n\n${learningsPrompt}`;
        }
      }

      // ── Inject codebase repository map ──
      try {
        const repoMap = await ASTParser.generateRepoMap(workspaceRoot);
        if (repoMap) {
          systemInstruction += `\n\n${repoMap}`;
        }
      } catch (repoMapErr) {
        console.error('Failed to generate repository map for system prompt:', repoMapErr);
      }

      // Set up the conversation messages array
      const conversationMessages: any[] = [];

      // Load past 100 messages for context (basic limitation)
      const startIdx = Math.max(0, this.chatHistory.length - 100);
      for (let i = startIdx; i < this.chatHistory.length; i++) {
        conversationMessages.push(this.chatHistory[i]);
      }

      // Auto-compaction: if loaded history exceeds 60% of our total budget, auto-compact to save context
      let totalSessionTokens = 0;
      for (const msg of conversationMessages) {
        totalSessionTokens += AIService.estimateTokens(msg.content || '');
      }
      if (totalSessionTokens > (tokenBudget * 0.6)) {
        vscode.window.showInformationMessage('K-Horizon: Auto-compacting chat history to fit token budget.');
        await this.compactSession();
        // Reload compacted history
        conversationMessages.length = 0;
        const startIdxCompacted = Math.max(0, this.chatHistory.length - 100);
        for (let i = startIdxCompacted; i < this.chatHistory.length; i++) {
          conversationMessages.push(this.chatHistory[i]);
        }
      }

      // ----------------------------------------------------
      // SPLIT SCREEN COMPARISON MODE (PARALLEL STREAMS)
      // ----------------------------------------------------
      if (isSplitScreen && modelId2) {
        this._view.webview.postMessage({ type: 'streamStart', column: 'left' });
        this._view.webview.postMessage({ type: 'streamStart', column: 'right' });
        this.isAgentRunning = true;
        
        conversationMessages.push({
          role: 'user',
          content: `${contextContent}User Request:\n${prompt}`,
          timestamp: Date.now()
        });
        
        const leftStream = AIService.streamResponse(
          conversationMessages,
          systemInstruction,
          (token) => {
            if (!this.isAgentRunning) return;
            this._view?.webview.postMessage({ type: 'streamToken', token: token, column: 'left' });
          },
          customProfile?.modelId || undefined,
          customProfile?.provider || undefined,
          customProfile?.temperature
        );
        
        const rightStream = AIService.streamResponse(
          conversationMessages,
          systemInstruction,
          (token) => {
            if (!this.isAgentRunning) return;
            this._view?.webview.postMessage({ type: 'streamToken', token: token, column: 'right' });
          },
          modelId2,
          provider2 || undefined,
          customProfile?.temperature
        );
        
        try {
          const [resLeft, resRight] = await Promise.all([leftStream, rightStream]);
          const combinedAssResult = `**Model 1 Output:**\n${resLeft}\n\n**Model 2 Output:**\n${resRight}`;
          
          try {
            await pool.query(
              `INSERT INTO chat_history (role, content, timestamp, session_id, session_title) 
               VALUES ($1, $2, $3, $4, $5)`,
              ['assistant', combinedAssResult, Date.now(), this.activeSessionId, sessionTitle]
            );
          } catch (dbErr) {
            console.error('Failed to save split-screen assistant response to DB:', dbErr);
          }
          
          this.chatHistory.push({ role: 'user', content: `${contextContent}User Request:\n${prompt}`, timestamp: Date.now() });
          this.chatHistory.push({ role: 'assistant', content: combinedAssResult, timestamp: Date.now() });
          
        } catch (streamErr: any) {
          this._view?.webview.postMessage({ type: 'streamError', error: streamErr.message || 'Stream failed' });
        } finally {
          this._view?.webview.postMessage({ type: 'streamEnd', column: 'left' });
          this._view?.webview.postMessage({ type: 'streamEnd', column: 'right' });
          this.isAgentRunning = false;
        }
        return;
      }

      // ----------------------------------------------------
      // STANDARD AGENT LOOP (LANGGRAPH)
      // ----------------------------------------------------
      this._view.webview.postMessage({ type: 'streamStart' });
      this.isAgentRunning = true;

      // Add user input with full resolved context to history
      const userMessageContent = `${contextContent}User Request:\n${prompt}`;
      const userTimestamp = Date.now();
      conversationMessages.push({
        role: 'user',
        content: userMessageContent,
        timestamp: userTimestamp
      });
      
      this.chatHistory.push({
        role: 'user',
        content: userMessageContent,
        timestamp: userTimestamp
      });

      // Persist user message to DB immediately so history survives reloads
      try {
        await pool.query(
          `INSERT INTO chat_history (role, content, timestamp, session_id, session_title) 
           VALUES ($1, $2, $3, $4, $5)`,
          ['user', userMessageContent, userTimestamp, this.activeSessionId, sessionTitle]
        );
      } catch (dbErr) {
        console.error('Failed to save user message to DB:', dbErr);
      }

      let assistantCompleted = false;

      try {
        const verificationCommands = this.detectVerificationCommands(workspaceRoot);
        const detectedCompileCmd = verificationCommands.compileCommand;
        const detectedTestCmd = verificationCommands.testCommand || detectedCompileCmd;
        const shouldRunAutoTest = autoTest && !!verificationCommands.testCommand;

        // ── Execute the LangGraph Agent ──
        try {
          // Ensure .k-horizon/ is ignored in the workspace .gitignore
          try {
            const gitignorePath = path.join(workspaceRoot, '.gitignore');
            let gitignoreContent = '';
            if (fs.existsSync(gitignorePath)) {
              gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
            }
            if (!gitignoreContent.includes('.k-horizon')) {
              const appendStr = gitignoreContent.endsWith('\n') || gitignoreContent === '' ? '.k-horizon/\n' : '\n.k-horizon/\n';
              fs.appendFileSync(gitignorePath, appendStr, 'utf8');
            }
          } catch (e) {
            console.error('Failed to update .gitignore:', e);
          }

          const runId = AgentTrace.createRunId();
          AgentTrace.append({
            runId,
            sessionId: this.activeSessionId,
            type: 'run_start',
            timestamp: Date.now(),
            data: {
              role,
              autoCompile,
              autoTest: shouldRunAutoTest,
              compileCommand: detectedCompileCmd,
              testCommand: verificationCommands.testCommand,
            },
          });

          ToolManager.resetWebSearchCount();
          const graph = createAgentGraph();
          const graphResult = await graph.invoke({
            chatHistory: conversationMessages,
            systemInstruction,
            modelConfig: {
              modelId: customProfile?.modelId || undefined,
              provider: customProfile?.provider || undefined,
              temperature: customProfile?.temperature,
            },
            onToken: (token: string) => {
              if (this.isAgentRunning) {
                this._view?.webview.postMessage({ type: 'streamToken', token });
              }
            },
            checkCancellation: () => !this.isAgentRunning,
            isRunning: true,
            loopCount: 0,
            maxLoops: 200,
            autoApprove,
            stepDebug,
            autoCompile,
            autoTest: shouldRunAutoTest,
            compileCommand: detectedCompileCmd,
            testCommand: detectedTestCmd,
            healAttempts: 0,
            finalResponse: '',
            workspaceRoot,
            runId,
            sessionId: this.activeSessionId,
            postMessage: (msg: any) => this._view?.webview.postMessage(msg),
            requestApproval: (callId: string, call: any, isStepMode: boolean) =>
              this.requestToolApproval(callId, call, isStepMode),
            requestChecklist: (calls: any[]) =>
              this.requestToolChecklist(calls),
            lastAssistantResponse: '',
            pendingToolCalls: [],
            compileCompleted: false,
            testCompleted: false,
            awaitingSelfHealResponse: false,
            codeChangesMade: false,
            currentSubagentId: subagent.id,
          }, {
            recursionLimit: 800,
            // MemorySaver requires a thread_id to know which conversation
            // thread to persist state for. We reuse the active chat session
            // ID so each session has its own resumable state slot.
            configurable: {
              thread_id: this.activeSessionId
            }
          });

          const finalResponse = graphResult.finalResponse || '';

          // Save assistant response to DB
          if (finalResponse) {
            try {
              await pool.query(
                `INSERT INTO chat_history (role, content, timestamp, session_id, session_title) 
                 VALUES ($1, $2, $3, $4, $5)`,
                ['assistant', finalResponse, Date.now(), this.activeSessionId, sessionTitle]
              );
            } catch (dbErr) {
              console.error('Failed to save assistant response to DB:', dbErr);
            }

            this.chatHistory.push({ role: 'assistant', content: finalResponse, timestamp: Date.now() });
            assistantCompleted = true;
          }
        } catch (graphErr: any) {
          // Surface the real error so the user can act on it. Empty `.message`
          // typically means a non-Error was thrown (string, object, etc.).
          const errText = graphErr?.message
            || (typeof graphErr === 'string' ? graphErr : '')
            || (graphErr?.code ? `${graphErr.code}` : '')
            || JSON.stringify(graphErr);
          console.error('LangGraph agent error:', graphErr);
          this._view?.webview.postMessage({
            type: 'streamToken',
            token: `\n\n❌ **Agent Error:** ${errText || 'Unknown error'}\n`,
          });
        }

        this.isAgentRunning = false;
        this._view?.webview.postMessage({ type: 'streamEnd' });
      } finally {
        if (!assistantCompleted) {
          // Rollback the unanswered user message
          if (this.chatHistory.length > 0 && this.chatHistory[this.chatHistory.length - 1].timestamp === userTimestamp) {
            this.chatHistory.pop();
          }
          try {
            await pool.query(
              `DELETE FROM chat_history WHERE session_id = $1 AND timestamp = $2 AND role = 'user'`,
              [this.activeSessionId, userTimestamp]
            );
          } catch (dbErr) {
            console.error('Failed to delete failed/cancelled user message from DB:', dbErr);
          }
        }
      }

    } catch (error: any) {
      const errText = error?.message
        || (typeof error === 'string' ? error : '')
        || (error?.code ? `${error.code}` : '')
        || JSON.stringify(error);
      console.error('Sidebar chat outer error:', error);
      this._view?.webview.postMessage({ type: 'streamError', error: errText || 'Unknown error' });
      this._view?.webview.postMessage({ type: 'streamEnd' });
      this.isAgentRunning = false;
    }
  }

  public async improvePrompt(prompt: string) {
    if (!this._view) return;

    try {
      const systemInstruction = `You are an expert Prompt Engineer specializing in Software Engineering AI Agents.
Your task is to take a draft user prompt and rewrite it into a highly effective, clear, structured, and comprehensive instruction for an AI Coding Assistant.

Guidelines:
1. Preserve the user's core intent, requested technologies, and technical constraints.
2. Structure the prompt clearly (e.g., using headings or bullet points if appropriate).
3. Specify best practices for clean code, strict TypeScript types, proper error handling, and writing unit tests if applicable.
4. Correct spelling, grammar, and phrasing to be professional and precise.
5. If the draft prompt is short or vague (e.g., "fix this bug"), expand it to ask for root-cause analysis, implementing the fix, verifying the build, and writing a test.
6. Do NOT include any explanations, conversational filler, markdown code fence blocks, or greetings. Output ONLY the improved prompt text itself.
7. Keep it concise but thorough. Let the improved prompt be ready to be sent to the AI agent.`;

      let accumulatedText = '';
      await AIService.streamResponse(
        [{ role: 'user', content: prompt, timestamp: Date.now() }],
        systemInstruction,
        (token) => {
          accumulatedText += token;
          this._view?.webview.postMessage({
            type: 'improvePromptProgress',
            text: accumulatedText
          });
        }
      );

      this._view.webview.postMessage({
        type: 'improvePromptComplete',
        text: accumulatedText.trim()
      });
    } catch (error: any) {
      console.error('Failed to improve prompt:', error);
      const errMsg = error?.message || 'Unknown error';
      this._view.webview.postMessage({
        type: 'improvePromptError',
        error: errMsg
      });
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const sharedCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'views', 'shared.css'));
    const sidebarJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'views', 'sidebar.js'));

    const htmlPath = vscode.Uri.joinPath(this._extensionUri, 'views', 'sidebar.html');
    let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');

    // Replace assets variables with cache-buster query params
    htmlContent = htmlContent.replace('##SHARED_CSS_URI##', `${sharedCssUri.toString()}?t=${Date.now()}`);
    htmlContent = htmlContent.replace('##SIDEBAR_JS_URI##', `${sidebarJsUri.toString()}?t=${Date.now()}`);
    htmlContent = htmlContent.replace(/##CSP_SOURCE##/g, webview.cspSource);

    return htmlContent;
  }
}
