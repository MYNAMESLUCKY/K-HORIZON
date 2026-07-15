import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Returns the most relevant workspace root for the current operation.
 *
 * Preference order:
 * 1. Workspace folder containing the provided URI/path.
 * 2. Workspace folder containing the active editor.
 * 3. The first open workspace folder.
 */
export function getWorkspaceRoot(target?: string | vscode.Uri): string {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) return '';

  if (typeof target === 'string' && target.trim()) {
    const absolute = path.isAbsolute(target) ? path.resolve(target) : undefined;
    if (absolute) {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absolute));
      if (folder) return folder.uri.fsPath;
    }
  } else if (target instanceof vscode.Uri) {
    const folder = vscode.workspace.getWorkspaceFolder(target);
    if (folder) return folder.uri.fsPath;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const folder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (folder) return folder.uri.fsPath;
  }

  return folders[0].uri.fsPath;
}
