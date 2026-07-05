import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { DiffBlock, LineDiffItem } from './types';
import { ToolManager } from './tool-manager';

export class DiffHandler {
  /**
   * Parses standard SEARCH/REPLACE blocks from LLM outputs.
   * Maps file path/name (string) to an array of DiffBlock.
   */
  /**
   * Heuristic regex for matching file-path declarations emitted by an LLM.
   * Examples it accepts:
   *   File: src/index.ts
   *   Path: src/index.ts
   *   ### src/index.ts
   *   **`src/index.ts`**
   * It will REJECT patterns that look like block headers (e.g. "### Workspace Folder Map")
   * because those phrases contain no file-extension / path-separator characters.
   */
  private static fileHeaderRegex = /^(?:[fF]ile|[pP]ath)\s*[:\-]\s*[`'*_]?([a-zA-Z0-9_\-\.\/\\]+)[`'*_]?\s*$|^(?:###|\*\*)\s*[`'*_]?((?:\.{1,2}|[\/\\]|[a-zA-Z0-9_\-]+\.[a-zA-Z0-9]+)[a-zA-Z0-9_\-\.\/\\]*)[`'*_]?\s*(?:\*\*)?\s*$/;

  /**
   * Parses standard SEARCH/REPLACE blocks from LLM outputs.
   * Maps file path/name (string) to an array of DiffBlock.
   */
  public static parseDiffs(text: string): Map<string, DiffBlock[]> {
    const fileDiffs = new Map<string, DiffBlock[]>();
    const lines = text.split('\n');

    let currentFile = '';
    let inSearch = false;
    let inReplace = false;
    let searchLines: string[] = [];
    let replaceLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Check for file header declaration
      const headerMatch = line.match(this.fileHeaderRegex);
      if (headerMatch && !inSearch && !inReplace) {
        const potentialFile = (headerMatch[1] || headerMatch[2] || '').trim();
        // Reject obvious non-paths and bare language tokens
        if (potentialFile &&
            !['js', 'ts', 'py', 'json', 'yaml', 'yml', 'md', 'html', 'css', 'javascript', 'typescript'].includes(potentialFile.toLowerCase()) &&
            potentialFile.length > 2) {
          currentFile = potentialFile;
        }
        continue;
      }

      if (trimmed.startsWith('<<<<<<< SEARCH')) {
        inSearch = true;
        searchLines = [];
        continue;
      }

      if (trimmed.startsWith('=======')) {
        inSearch = false;
        inReplace = true;
        replaceLines = [];
        continue;
      }

      if (trimmed.startsWith('>>>>>>> REPLACE')) {
        inReplace = false;
        if (currentFile) {
          const searchContent = searchLines.join('\n');
          const replaceContent = replaceLines.join('\n');
          
          if (!fileDiffs.has(currentFile)) {
            fileDiffs.set(currentFile, []);
          }
          fileDiffs.get(currentFile)!.push({ searchContent, replaceContent });
        }
        continue;
      }

      if (inSearch) {
        searchLines.push(line);
      } else if (inReplace) {
        replaceLines.push(line);
      }
    }

    return fileDiffs;
  }

  /**
   * Applies the DiffBlocks to a file. If the file does not exist, it will be created.
   * Returns true if all changes applied successfully, false otherwise.
   */
  public static async applyDiffsToFile(
    filePath: string,
    diffs: DiffBlock[]
  ): Promise<{ success: boolean; error?: string; modifiedContent?: string }> {
    try {
      const uri = vscode.Uri.file(filePath);
      let originalContent = '';
      let fileExists = fs.existsSync(filePath);

      if (fileExists) {
        const document = await vscode.workspace.openTextDocument(uri);
        originalContent = document.getText();
      }

      let currentContent = originalContent;

      for (const diff of diffs) {
        const normalizedSearch = this.normalizeContent(diff.searchContent);
        const normalizedFile = this.normalizeContent(currentContent);

        // For new files, the search block is usually empty. We just replace everything or append.
        if (normalizedSearch === '' && (!fileExists || normalizedFile === '')) {
          currentContent = diff.replaceContent;
          continue;
        }

        const replaceResult = ToolManager.applyFlexibleReplacement(
          currentContent,
          diff.searchContent,
          diff.replaceContent
        );

        if (replaceResult) {
          currentContent = replaceResult.content;
        } else {
          return {
            success: false,
            error: `Could not find code block in file, even with whitespace-tolerant matching:\n<<<<<<< SEARCH\n${diff.searchContent}\n=======\n`
          };
        }
      }

      // Write changes via WorkspaceEdit so it is undoable by the user in VS Code
      const workspaceEdit = new vscode.WorkspaceEdit();
      if (!fileExists) {
        // Create file
        const parentDir = path.dirname(filePath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        workspaceEdit.createFile(uri, { overwrite: true });
        workspaceEdit.insert(uri, new vscode.Position(0, 0), currentContent);
      } else {
        const document = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(originalContent.length)
        );
        workspaceEdit.replace(uri, fullRange, currentContent);
      }

      const editSuccess = await vscode.workspace.applyEdit(workspaceEdit);
      if (editSuccess) {
        return { success: true, modifiedContent: currentContent };
      } else {
        return { success: false, error: 'VS Code failed to apply workspace edit.' };
      }
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Standardizes CRLF to LF and trims trailing spaces on lines.
   */
  private static normalizeContent(content: string): string {
    return content
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
      .trim();
  }

  /**
   * Generates a line-by-line diff between two strings using standard dynamic programming (LCS).
   */
  public static generateLineDiff(original: string, proposed: string): LineDiffItem[] {
    const origLines = original === '' ? [] : original.split(/\r?\n/);
    const propLines = proposed === '' ? [] : proposed.split(/\r?\n/);
    const dp: number[][] = Array(origLines.length + 1).fill(0).map(() => Array(propLines.length + 1).fill(0));
    for (let i = 1; i <= origLines.length; i++) {
      for (let j = 1; j <= propLines.length; j++) {
        if (origLines[i-1] === propLines[j-1]) {
          dp[i][j] = dp[i-1][j-1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
        }
      }
    }
    const diff: LineDiffItem[] = [];
    let i = origLines.length;
    let j = propLines.length;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && origLines[i-1] === propLines[j-1]) {
        diff.push({ type: 'normal', text: origLines[i-1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
        diff.push({ type: 'added', text: propLines[j-1] });
        j--;
      } else {
        diff.push({ type: 'removed', text: origLines[i-1] });
        i--;
      }
    }
    return diff.reverse();
  }

}

