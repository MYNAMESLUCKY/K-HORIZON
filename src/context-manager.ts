import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WorkspaceFile } from './types';
import { AIService } from './ai-service';
import { DBClient } from './db-client';

export class ContextManager {
  private static summaryCache = new Map<string, { summary: string; mtime: number }>();
  private static gitignoreCache = new Map<string, string[]>();

  /**
   * Reads .gitignore patterns from the workspace root and parses them into a
   * simple glob-like matcher (only supports the common cases: *, **, trailing /).
   * Cached per workspace root.
   */
  private static loadGitignore(workspaceRoot: string): string[] {
    if (this.gitignoreCache.has(workspaceRoot)) {
      return this.gitignoreCache.get(workspaceRoot)!;
    }
    const patterns: string[] = [];
    try {
      const gitignorePath = path.join(workspaceRoot, '.gitignore');
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf8');
        for (const rawLine of content.split('\n')) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) continue;
          patterns.push(line.replace(/\/$/, ''));
        }
      }
    } catch { /* ignore */ }
    this.gitignoreCache.set(workspaceRoot, patterns);
    return patterns;
  }

  /**
   * Very small .gitignore matcher. Supports directory names, leading/trailing globs,
   * and ** patterns. Good enough to filter out typical build/cache dirs without
   * pulling in a heavy dependency.
   */
  private static isGitignored(relativePath: string, patterns: string[]): boolean {
    const parts = relativePath.split(/[\\/]/);
    for (const pattern of patterns) {
      if (pattern.includes('**')) {
        // Convert ** to .* and * to [^/]* for a regex test on the full relative path
        const re = new RegExp('^' + pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*')
          + '(/|$)');
        if (re.test(relativePath)) return true;
      } else if (pattern.includes('*')) {
        const re = new RegExp('^' + pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')
          + '$');
        if (re.test(parts[parts.length - 1])) return true;
      } else {
        // Plain name: match if any path segment equals it
        if (parts.includes(pattern)) return true;
      }
    }
    return false;
  }

  /**
   * Scans the workspace and returns a list of files that can be selected.
   * Honors .gitignore patterns from the workspace root in addition to the
   * hard-coded exclusion list.
   */
  public static async getWorkspaceFiles(maxResults = 2000): Promise<WorkspaceFile[]> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const gitignore = workspaceRoot ? this.loadGitignore(workspaceRoot) : [];

    const files = await vscode.workspace.findFiles(
      '**/*',
      '**/{node_modules,.git,dist,out,build,.next,bin,obj,vendor}/**',
      maxResults
    );

    const workspaceFiles: WorkspaceFile[] = [];
    for (const file of files) {
      const relativePath = vscode.workspace.asRelativePath(file);
      if (gitignore.length > 0 && this.isGitignored(relativePath, gitignore)) {
        continue;
      }
      workspaceFiles.push({
        filePath: file.fsPath,
        relativePath: relativePath
      });
    }
    return workspaceFiles;
  }

  /**
   * Resolves the contents of a list of referenced files, applying token saving summaries for large files.
   */
  public static async resolveFileContents(filePaths: string[]): Promise<WorkspaceFile[]> {
    const results: WorkspaceFile[] = [];

    for (const filePath of filePaths) {
      try {
        const uri = vscode.Uri.file(filePath);
        const relPath = vscode.workspace.asRelativePath(uri);
        const document = await vscode.workspace.openTextDocument(uri);
        const text = document.getText();

        let processedContent = text;
        const lineCount = document.lineCount;

        if (lineCount > 400) {
          processedContent = await this.getSummaryFromCacheOrLLM(filePath, relPath, text);
        }

        results.push({
          filePath: filePath,
          relativePath: relPath,
          content: processedContent
        });
      } catch (e) {
        console.error(`Failed to read file context for ${filePath}:`, e);
      }
    }

    return results;
  }

  /**
   * Retrieves a cached file summary from Supabase or prompts the Ollama cloud model to generate one.
   */
  private static async getSummaryFromCacheOrLLM(
    filePath: string,
    relativePath: string,
    fileContent: string
  ): Promise<string> {
    try {
      const fileStats = fs.statSync(filePath);
      const mtime = fileStats.mtimeMs;

      // Check memory cache first
      const memCached = this.summaryCache.get(filePath);
      if (memCached && memCached.mtime === mtime) {
        return memCached.summary;
      }

      const pool = await DBClient.initialize();
      // Check database cache
      const result = await pool.query(
        'SELECT summary, mtime FROM file_summaries WHERE file_path = $1',
        [filePath]
      );

      if (result.rows.length > 0) {
        const cachedRow = result.rows[0];
        const cachedMtime = parseFloat(cachedRow.mtime);
        if (cachedMtime === mtime) {
          this.summaryCache.set(filePath, { summary: cachedRow.summary, mtime });
          return cachedRow.summary;
        }
      }

      // Show temporary status bar notification
      vscode.window.setStatusBarMessage(`$(sync~spin) K-Horizon: Compressing @${path.basename(filePath)}...`, 3000);

      // Call Ollama gpt-oss:120b-cloud model
      let summary = await AIService.generateSummary(relativePath, fileContent);

      // Fallback to local regex generator if LLM summary failed
      if (!summary || summary.trim() === '') {
        summary = this.summarizeLargeFile(fileContent, relativePath);
      }

      // Save to Supabase cache
      await pool.query(
        `INSERT INTO file_summaries (file_path, relative_path, summary, mtime, updated_at) 
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (file_path) 
         DO UPDATE SET summary = EXCLUDED.summary, mtime = EXCLUDED.mtime, updated_at = NOW()`,
        [filePath, relativePath, summary, mtime]
      );

      this.summaryCache.set(filePath, { summary, mtime });

      return summary;

    } catch (e) {
      console.error('Failed cache resolution:', e);
      return this.summarizeLargeFile(fileContent, relativePath);
    }
  }

  /**
   * Extracts the skeleton structure of a large file (imports, classes, functions, and exports)
   * while stripping implementation details to fit in tight token budgets.
   */
  private static summarizeLargeFile(content: string, _relativePath: string): string {
    const lines = content.split('\n');
    const summarizedLines: string[] = [];
    
    // Always keep imports and top config (first 35 lines)
    const headerLimit = Math.min(35, lines.length);
    for (let i = 0; i < headerLimit; i++) {
      summarizedLines.push(lines[i]);
    }

    if (lines.length <= headerLimit) {
      return content;
    }

    summarizedLines.push(`\n// ... [Lines 36 to ${lines.length - 15} omitted for token efficiency] ...`);
    summarizedLines.push(`// ... [Displaying file structure outline below] ...\n`);

    // Patterns for interesting structure lines
    // Matches classes, functions, interfaces, exports, and Python defs
    const structureRegex = /^(export\s+|declare\s+)?(class|interface|function|const|let|enum|type|def|struct|impl|fn|trait|contract|module)\s+([a-zA-Z0-9_$]+)/;

    let skippedLinesCount = 0;
    // Scan middle of the file for declarations
    for (let i = headerLimit; i < lines.length - 15; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (structureRegex.test(trimmed)) {
        if (skippedLinesCount > 0) {
          summarizedLines.push(`  // ... [${skippedLinesCount} lines of body implementation omitted] ...`);
          skippedLinesCount = 0;
        }
        summarizedLines.push(line);
      } else {
        skippedLinesCount++;
      }
    }

    if (skippedLinesCount > 0) {
      summarizedLines.push(`  // ... [${skippedLinesCount} lines of body implementation omitted] ...`);
    }

    // Always keep bottom lines of the file (exports, final lines)
    summarizedLines.push(`\n// ... [File Footer] ...`);
    const footerStart = Math.max(lines.length - 15, headerLimit);
    for (let i = footerStart; i < lines.length; i++) {
      summarizedLines.push(lines[i]);
    }

    return summarizedLines.join('\n');
  }

  /**
   * Helper to fetch details about the active editor: selected text, file name, surrounding context.
   */
  public static getActiveEditorContext(): {
    filePath: string;
    relativePath: string;
    selectionText: string;
    surroundingContext: string;
    languageId: string;
    startLine: number;
    endLine: number;
  } | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;

    const document = editor.document;
    const selection = editor.selection;
    const filePath = document.uri.fsPath;
    const relativePath = vscode.workspace.asRelativePath(document.uri);
    const languageId = document.languageId;

    let selectionText = '';
    let startLine = 0;
    let endLine = 0;

    if (!selection.isEmpty) {
      selectionText = document.getText(selection);
      startLine = selection.start.line + 1;
      endLine = selection.end.line + 1;
    } else {
      // If nothing selected, grab the current line
      const currentLine = selection.active.line;
      selectionText = document.lineAt(currentLine).text;
      startLine = currentLine + 1;
      endLine = currentLine + 1;
    }

    // Get surrounding lines for context
    const contextRangeLines = 8;
    const docLines = document.lineCount;
    
    const contextStartLine = Math.max(0, (selection.isEmpty ? selection.active.line : selection.start.line) - contextRangeLines);
    const contextEndLine = Math.min(docLines - 1, (selection.isEmpty ? selection.active.line : selection.end.line) + contextRangeLines);

    let surroundingContext = '';
    for (let i = contextStartLine; i <= contextEndLine; i++) {
      const lineText = document.lineAt(i).text;
      if (i === (selection.isEmpty ? selection.active.line : selection.start.line)) {
        surroundingContext += `>>> SELECTED CODE START <<<\n`;
      }
      surroundingContext += `${lineText}\n`;
      if (i === (selection.isEmpty ? selection.active.line : selection.end.line)) {
        surroundingContext += `>>> SELECTED CODE END <<<\n`;
      }
    }

    return {
      filePath,
      relativePath,
      selectionText,
      surroundingContext,
      languageId,
      startLine,
      endLine
    };
  }
}
