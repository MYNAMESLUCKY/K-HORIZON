import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { MessageBroker } from './message-broker';
import type { SidebarProvider } from '../sidebar-provider';
import { DiffHandler } from '../diff-handler';

/**
 * Registers diff-domain message handlers:
 *   requestDiffLines, viewSideBySideDiff, viewSidebarDiff, rollback
 */
export function registerDiffHandlers(broker: MessageBroker, provider: SidebarProvider): void {
  broker.on('requestDiffLines', (data) => {
    try {
      const originalContent = fs.existsSync(data.originalPath) ? fs.readFileSync(data.originalPath, 'utf8') : '';
      const proposedContent = fs.existsSync(data.proposedPath) ? fs.readFileSync(data.proposedPath, 'utf8') : '';
      const diffLines = DiffHandler.generateLineDiff(originalContent, proposedContent);
      provider.postMessage({
        type: 'diffLinesResponse',
        filePath: data.filePath,
        diffLines: diffLines
      });
    } catch (err: any) {
      console.error('Failed to generate diff lines:', err);
    }
  });

  broker.on('viewSideBySideDiff', async (data) => {
    await vscode.commands.executeCommand(
      'vscode.diff',
      vscode.Uri.file(data.originalPath),
      vscode.Uri.file(data.proposedPath),
      'Diff: ' + path.basename(data.proposedPath)
    );
  });

  broker.on('viewSidebarDiff', async (data) => {
    await provider.viewSidebarDiff(data.name, data.args);
  });

  broker.on('rollback', async () => {
    await provider.handleRollback();
  });
}
