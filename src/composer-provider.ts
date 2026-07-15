import * as vscode from 'vscode';
import { AIService } from './ai-service';
import { ContextManager } from './context-manager';
import { DiffHandler } from './diff-handler';
import { ToolManager } from './tool-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getWorkspaceRoot } from './workspace-utils';
import { AgentLearningManager } from './learning-manager';
import { ASTParser } from './ast-parser';

interface ProposedChange {
  filePath: string;
  relativePath: string;
  originalPath: string;
  proposedPath: string;
  isNew: boolean;
  status: 'pending' | 'accepted' | 'rejected';
}

export class ComposerProvider {
  private static panel: vscode.WebviewPanel | undefined;
  private static activeChanges: ProposedChange[] = [];
  private static extensionUri: vscode.Uri;
  private static activeCts: vscode.CancellationTokenSource | undefined;

  public static initialize(context: vscode.ExtensionContext) {
    this.extensionUri = context.extensionUri;

    context.subscriptions.push(
      vscode.commands.registerCommand('k-horizon.composer', () => {
        this.showPanel();
      })
    );
  }

  public static showPanel() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'k-horizon-composer',
      'K-Horizon Composer',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri]
      }
    );

    this.panel.webview.html = this.getHtmlForWebview(this.panel.webview);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.cleanupTempFiles();
    });

    // Handle messages from Webview
    this.panel.webview.onDidReceiveMessage(async (data) => {
      switch (data.command) {
        case 'requestWorkspaceFiles':
          this.sendWorkspaceFiles();
          this.sendSettings();
          break;

        case 'compose':
          await this.handleCompose(data.prompt, data.files, data.modelId, data.provider);
          break;

        case 'stop':
          this.cancelCompose();
          break;

        case 'viewDiff':
          this.viewDiff(data.filePath, data.originalPath, data.proposedPath);
          break;

        case 'acceptChange':
          await this.acceptChange(data.filePath);
          break;

        case 'rejectChange':
          await this.rejectChange(data.filePath);
          break;

        case 'acceptAll':
          await this.acceptAll();
          break;

        case 'discardAll':
          await this.discardAll();
          break;

        case 'openFilePicker':
          await this.handleOpenFilePicker();
          break;
      }
    });
  }

  private static async sendWorkspaceFiles() {
    if (!this.panel) return;
    try {
      const files = await ContextManager.getWorkspaceFiles(2000);
      this.panel.webview.postMessage({
        type: 'workspaceFiles',
        files: files
      });
    } catch (e) {
      console.error(e);
    }
  }

  private static async sendSettings() {
    if (!this.panel) return;
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
      console.error('Composer: Failed to query vscode.lm models:', e);
    }

    this.panel.webview.postMessage({
      type: 'settingsUpdate',
      provider: settings.provider,
      chatModel: settings.chatModel,
      customModels: settings.customModels || [],
      vscodeLMModels: vscodeLMModels
    });
  }

  private static async handleOpenFilePicker() {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Add to Composer Context',
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
      this.panel?.webview.postMessage({
        type: 'addReferencedFiles',
        files: fileData
      });
    }
  }

  /**
   * Prompts the AI for multi-file alterations and processes the SEARCH/REPLACE response.
   */
  private static async handleCompose(prompt: string, referencedPaths: string[], modelOverride?: string, providerOverride?: string) {
    if (!this.panel) return;
    const workspaceRoot = getWorkspaceRoot();

    this.cleanupTempFiles();
    this.activeChanges = [];

    if (this.activeCts) {
      this.activeCts.dispose();
    }
    this.activeCts = new vscode.CancellationTokenSource();

    try {
      this.panel.webview.postMessage({ type: 'statusUpdate', text: 'Analyzing repository files...' });

      // Gather settings and setup token budget allocator
      const settings = AIService.getSettings();
      const tokenBudget = await AIService.getMaxContextTokens();
      let currentTokenCount = 0;
      let contextContent = '';

      const addContextBlock = (header: string, contentText: string) => {
        const blockText = `${header}\n\`\`\`\n${contentText}\n\`\`\`\n\n`;
        const blockTokens = AIService.estimateTokens(blockText);
        
        if (currentTokenCount + blockTokens < tokenBudget) {
          contextContent += blockText;
          currentTokenCount += blockTokens;
          return true;
        } else {
          const remainingTokens = tokenBudget - currentTokenCount;
          if (remainingTokens > 500) {
            const charLimit = remainingTokens * 4;
            const truncatedText = contentText.substring(0, charLimit) + `\n// ... [rest of file content truncated to fit token budget] ...`;
            contextContent += `${header} (Truncated to fit budget):\n\`\`\`\n${truncatedText}\n\`\`\`\n\n`;
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
          addContextBlock(`### Active Workspace File: \`${file.relativePath}\``, file.content || '');
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
            const workspaceRoot = getWorkspaceRoot();
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

      // Add high-level folder structure map
      const allFiles = await ContextManager.getWorkspaceFiles(1000);
      let layoutDesc = `### Workspace Folder Map:\n`;
      allFiles.forEach(f => {
        layoutDesc += `- ${f.relativePath}\n`;
      });
      layoutDesc += `\n`;

      const layoutTokens = AIService.estimateTokens(layoutDesc);
      if (currentTokenCount + layoutTokens < tokenBudget) {
        contextContent += layoutDesc;
        currentTokenCount += layoutTokens;
      }

      const now = new Date();
      const timeString = now.toString();
      const systemInstruction = `Current local date and time: ${timeString}.

You are a Principal Software Architect who handles workspace-wide changes.
Modify or create files as requested by the user.

## PROJECT SCAFFOLDING (when the workspace has no package.json)

If the workspace is empty or has no package.json, you MUST scaffold the project first:
1. Create \`package.json\` with appropriate name, scripts, and dependencies.
2. Create config files: \`tsconfig.json\`, \`vite.config.ts\`, \`tailwind.config.js\`, \`postcss.config.js\`, etc.
3. Create source files: \`index.html\`, \`src/main.tsx\`, \`src/App.tsx\`, \`src/index.css\`, etc.
4. After creating ALL files, add a FINAL STEPS section listing the npm commands the user
   must run (e.g., \`npm install\`, \`npm run dev\`) since you cannot run commands yourself.

## FILE EDITING

For each file you modify or create:
1. Declare the file path: 'File: path/to/file'
2. Output a SEARCH/REPLACE block for that file.
3. For brand new files, declare the path and use an empty search block:
   <<<<<<< SEARCH
   =======
   [code]
   >>>>>>> REPLACE
4. Do NOT compromise on code quality or completeness to save tokens. Never use placeholders
   or comments like '// rest of code remains the same' to truncate code blocks. Always
   provide complete, working implementations in all code blocks and file edits.

Format Example:
File: src/math.ts
<<<<<<< SEARCH
const a = 1;
=======
const a = 100;
>>>>>>> REPLACE

For most requests, output ONLY the file declarations and their SEARCH/REPLACE blocks.
For new projects, you MAY add a "FINAL STEPS" section after all file blocks listing
the npm commands the user must run to install dependencies and start the project.

## CODING STANDARDS (MUST FOLLOW)

Apply these consistently across all code you write or edit:

- **TypeScript strict mode**: honor the project's tsconfig.json "strict" flag. Do not introduce \`any\`, \`@ts-ignore\`, or \`@ts-expect-error\` unless the existing codebase already uses them.
- **Implicit Any**: under strict type checking, always provide explicit type annotations for function parameters and callback arguments (e.g. \`(item: ItemType, index: number) => ...\` instead of JS-style \`(item, index) => ...\`).
- **Unused Locals & Parameters**: under strict compiler flags like "noUnusedLocals" and "noUnusedParameters", always clean up any unused variables, parameters, or imports before finalizing files. Never leave unused imports.
- **Import & Dependency Verification**: NEVER guess or assume exports, names, or types of other modules or files in the workspace. Before writing an import statement, you MUST read the target file (using \`read_file\`) to see what it actually exports and what types it uses.
- **Animation & Library Type-casting**: When using libraries like Framer Motion or others that expect specific tuple shapes for arrays (e.g. cubic-bezier easing arrays), always append \`as const\` or type them explicitly (e.g. \`ease: [0.6, 0.05, -0.01, 0.9] as const\` or \`ease: [0.6, 0.05, -0.01, 0.9] as [number, number, number, number]\`) to avoid compiler array type mismatches.
- **Line Number Shifts Warning**: Line numbers in a file shift after any edits are made. If you have already edited a file in a prior turn, do NOT use line numbers from older compile/test outputs. Always re-read the file with \`read_file\` to get fresh line numbers before calling line-specific tools like \`patch_file_lines\` or \`insert_file_lines\`.`;

      let dynamicSystemInstruction = systemInstruction;
      const enableContinuousLearning = vscode.workspace.getConfiguration('k-horizon').get<boolean>('enableContinuousLearning', true);
      if (enableContinuousLearning) {
        const learningsPrompt = await AgentLearningManager.loadLearningsAsPrompt(workspaceRoot);
        if (learningsPrompt) {
          dynamicSystemInstruction += `\n\n${learningsPrompt}`;
        }
      }

      // ── Inject codebase repository map ──
      try {
        const repoMap = await ASTParser.generateRepoMap(workspaceRoot);
        if (repoMap) {
          dynamicSystemInstruction += `\n\n${repoMap}`;
        }
      } catch (repoMapErr) {
        console.error('Failed to generate repository map for system prompt:', repoMapErr);
      }

      this.panel.webview.postMessage({ type: 'statusUpdate', text: 'Prompting multi-file agent...' });
      this.panel.webview.postMessage({ type: 'streamStart', text: 'Composer stream started.' });

      const userMessage = `${contextContent}User Prompt:\n${prompt}`;
      
      const fullResponse = await AIService.streamResponse(
        [{ role: 'user', content: userMessage, timestamp: Date.now() }],
        dynamicSystemInstruction,
        (streamToken) => {
          if (this.panel) {
            this.panel.webview.postMessage({ type: 'streamToken', token: streamToken });
          }
        },
        modelOverride || undefined,
        providerOverride || undefined,
        undefined,
        this.activeCts.token
      );

      this.panel.webview.postMessage({ type: 'streamEnd', text: 'Composer stream finished. Parsing proposed changes...' });
      this.panel.webview.postMessage({ type: 'statusUpdate', text: 'Parsing proposed changes...' });

      // Parse SEARCH/REPLACE blocks
      const fileDiffs = DiffHandler.parseDiffs(fullResponse);

      if (fileDiffs.size === 0) {
        this.panel.webview.postMessage({ type: 'streamEnd', text: 'No proposed changes were returned.' });
        this.panel.webview.postMessage({ type: 'proposedChanges', changes: [] });
        return;
      }

      const tempDir = os.tmpdir();

      for (const [fileKey, diffs] of fileDiffs.entries()) {
        // Resolve absolute target path
        let targetFilePath = fileKey;
        if (!path.isAbsolute(targetFilePath)) {
          targetFilePath = path.join(workspaceRoot, fileKey);
        }

        const absResolved = path.resolve(targetFilePath);
        const absRoot = path.resolve(workspaceRoot);
        const relative = path.relative(absRoot, absResolved);
        const isInsideWorkspace = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));

        if (!isInsideWorkspace) {
          this.panel.webview.postMessage({
            type: 'streamError',
            error: `Refusing to edit file outside the workspace: ${fileKey}`
          });
          continue;
        }

        const relativePath = vscode.workspace.asRelativePath(vscode.Uri.file(targetFilePath));
        const fileExists = fs.existsSync(targetFilePath);
        let originalContent = '';

        if (fileExists) {
          originalContent = fs.readFileSync(targetFilePath, 'utf8');
        }

        // Apply DiffBlocks onto original content to compute proposed changes
        let proposedContent = originalContent;
        let diffError = false;

        for (const diff of diffs) {
          const res = this.applySingleDiffLocally(proposedContent, diff.searchContent, diff.replaceContent);
          if (res !== null) {
            proposedContent = res;
          } else {
            diffError = true;
            break;
          }
        }

        if (diffError) {
          this.panel.webview.postMessage({
            type: 'streamError',
            error: `Could not match one or more SEARCH blocks in ${relativePath}. Open the file and retry with a smaller edit block.`
          });
          continue;
        }

        // Create random unique temp file names
        const randomId = Math.random().toString(36).substring(7);
        const fileName = path.basename(targetFilePath);
        const tempOriginalPath = path.join(tempDir, `k_horizon_orig_${randomId}_${fileName}`);
        const tempProposedPath = path.join(tempDir, `k_horizon_prop_${randomId}_${fileName}`);

        // Write original and proposed text to temp files for VS Code side-by-side diff comparisons
        fs.writeFileSync(tempOriginalPath, originalContent, 'utf8');
        fs.writeFileSync(tempProposedPath, proposedContent, 'utf8');

        this.activeChanges.push({
          filePath: targetFilePath,
          relativePath: relativePath,
          originalPath: tempOriginalPath,
          proposedPath: tempProposedPath,
          isNew: !fileExists,
          status: 'pending'
        });
      }

      // Notify frontend
      if (this.activeChanges.length === 0) {
        this.panel.webview.postMessage({ type: 'streamEnd', text: 'No safely applicable proposed changes were found.' });
      }

      this.panel.webview.postMessage({
        type: 'proposedChanges',
        changes: this.activeChanges.map(c => ({
          filePath: c.filePath,
          relativePath: c.relativePath,
          originalPath: c.originalPath,
          proposedPath: c.proposedPath,
          isNew: c.isNew,
          status: c.status
        }))
      });

    } catch (e: any) {
      if (e.message !== 'Request aborted by user cancellation.') {
        vscode.window.showErrorMessage(`Composer error: ${e.message}`);
        this.panel.webview.postMessage({ type: 'streamError', error: e.message || 'Composer failed.' });
        this.panel.webview.postMessage({ type: 'statusUpdate', text: `Error: ${e.message}` });
      } else {
        this.panel.webview.postMessage({ type: 'streamEnd', text: 'Composer stream cancelled.' });
        this.panel.webview.postMessage({ type: 'statusUpdate', text: 'Composer stream cancelled.' });
      }
    } finally {
      if (this.activeCts) {
        this.activeCts.dispose();
        this.activeCts = undefined;
      }
    }
  }

  public static cancelCompose() {
    if (this.activeCts) {
      this.activeCts.cancel();
      this.activeCts.dispose();
      this.activeCts = undefined;
    }
    if (this.panel) {
      this.panel.webview.postMessage({ type: 'streamEnd', text: 'Composer stream cancelled.' });
      this.panel.webview.postMessage({ type: 'composerReset' });
    }
  }

  /**
   * Helper to perform local search/replace strings.
   */
  private static applySingleDiffLocally(content: string, search: string, replace: string): string | null {
    const normContent = content.replace(/\r\n/g, '\n');
    const normSearch = search.replace(/\r\n/g, '\n');

    if (normSearch === '' && normContent === '') {
      return replace.replace(/\r\n/g, '\n');
    }

    return ToolManager.applyFlexibleReplacement(content, search, replace)?.content || null;
  }

  private static viewDiff(filePath: string, originalPath: string, proposedPath: string) {
    const fileName = path.basename(filePath);
    vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(originalPath),
      vscode.Uri.file(proposedPath),
      `Diff: ${fileName} (Proposed)`
    );
  }

  private static async acceptChange(filePath: string) {
    const change = this.activeChanges.find(c => c.filePath === filePath);
    if (!change || change.status !== 'pending') return;

    try {
      const parentDir = path.dirname(filePath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // Read from proposed temp file and copy to workspace
      const content = fs.readFileSync(change.proposedPath, 'utf8');
      
      const workspaceEdit = new vscode.WorkspaceEdit();
      const fileUri = vscode.Uri.file(filePath);

      if (change.isNew) {
        workspaceEdit.createFile(fileUri, { overwrite: true });
        workspaceEdit.insert(fileUri, new vscode.Position(0, 0), content);
      } else {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const range = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        workspaceEdit.replace(fileUri, range, content);
      }

      const success = await vscode.workspace.applyEdit(workspaceEdit);
      if (success) {
        change.status = 'accepted';
        this.panel?.webview.postMessage({
          type: 'changeStatusUpdate',
          filePath: filePath,
          status: 'accepted'
        });
        vscode.window.showInformationMessage(`Applied changes to ${path.basename(filePath)}`);
      } else {
        throw new Error('WorkspaceEdit apply returned false.');
      }
    } catch (e: any) {
      vscode.window.showErrorMessage(`Failed to apply changes to ${path.basename(filePath)}: ${e.message}`);
    }
  }

  private static async rejectChange(filePath: string) {
    const change = this.activeChanges.find(c => c.filePath === filePath);
    if (!change || change.status !== 'pending') return;

    change.status = 'rejected';
    this.panel?.webview.postMessage({
      type: 'changeStatusUpdate',
      filePath: filePath,
      status: 'rejected'
    });

    // Delete temp files
    try {
      if (fs.existsSync(change.originalPath)) fs.unlinkSync(change.originalPath);
      if (fs.existsSync(change.proposedPath)) fs.unlinkSync(change.proposedPath);
    } catch (e) {}
  }

  private static async acceptAll() {
    const pendingChanges = this.activeChanges.filter(c => c.status === 'pending');
    for (const change of pendingChanges) {
      await this.acceptChange(change.filePath);
    }
    vscode.window.showInformationMessage('All proposed workspace edits accepted.');
    this.panel?.webview.postMessage({ type: 'composerReset' });
    this.cleanupTempFiles();
  }

  private static async discardAll() {
    const pendingChanges = this.activeChanges.filter(c => c.status === 'pending');
    for (const change of pendingChanges) {
      await this.rejectChange(change.filePath);
    }
    vscode.window.showInformationMessage('All proposed workspace edits discarded.');
    this.panel?.webview.postMessage({ type: 'composerReset' });
    this.cleanupTempFiles();
  }

  private static cleanupTempFiles() {
    for (const change of this.activeChanges) {
      try {
        if (fs.existsSync(change.originalPath)) fs.unlinkSync(change.originalPath);
        if (fs.existsSync(change.proposedPath)) fs.unlinkSync(change.proposedPath);
      } catch (e) {}
    }
    this.activeChanges = [];
  }

  private static getHtmlForWebview(webview: vscode.Webview) {
    const sharedCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'views', 'shared.css'));
    const composerJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'views', 'composer.js'));

    const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'views', 'composer.html');
    let htmlContent = fs.readFileSync(htmlPath.fsPath, 'utf8');

    // Replace assets variables with cache-buster query params
    htmlContent = htmlContent.replace('##SHARED_CSS_URI##', `${sharedCssUri.toString()}?t=${Date.now()}`);
    htmlContent = htmlContent.replace('##COMPOSER_JS_URI##', `${composerJsUri.toString()}?t=${Date.now()}`);
    htmlContent = htmlContent.replace(/##CSP_SOURCE##/g, webview.cspSource);

    return htmlContent;
  }
}
