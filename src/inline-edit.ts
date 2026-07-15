import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AIService } from './ai-service';
import { ContextManager } from './context-manager';
import { DiffHandler } from './diff-handler';

export class InlineEditManager {
  private static addedDecoration: vscode.TextEditorDecorationType;
  private static removedDecoration: vscode.TextEditorDecorationType;
  private static isEditActive = false;
  private static originalText = '';
  private static originalFileContent = '';
  private static originalRange: vscode.Range;
  private static currentRange: vscode.Range;
  private static activeEditor: vscode.TextEditor | undefined;

  public static initialize(context: vscode.ExtensionContext) {
    // Create text decorations for visual diff highlights
    this.addedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(74, 187, 115, 0.2)', // Light green
      isWholeLine: true
    });

    this.removedDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(235, 87, 87, 0.2)', // Light red
      isWholeLine: true
    });

    // Register acceptance command
    context.subscriptions.push(
      vscode.commands.registerCommand('k-horizon.inline-edit-accept', () => {
        this.acceptEdit();
      })
    );

    // Register rejection command
    context.subscriptions.push(
      vscode.commands.registerCommand('k-horizon.inline-edit-reject', () => {
        this.rejectEdit();
      })
    );
  }

  /**
   * Triggers the Ctrl+Shift+K inline editing flow.
   */
  public static async triggerInlineEdit() {
    if (this.isEditActive) {
      vscode.window.showWarningMessage('Please accept or reject the current inline edit before starting a new one.');
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active text editor found.');
      return;
    }

    const context = ContextManager.getActiveEditorContext();
    if (!context) return;

    // Prompt user for instructions
    const prompt = await vscode.window.showInputBox({
      prompt: 'Describe the edits or code generation you want',
      placeHolder: 'e.g. "add input validation" or "refactor this function to be async"'
    });

    if (!prompt) return;

    this.activeEditor = editor;
    this.isEditActive = true;
    this.originalText = context.selectionText;
    this.originalFileContent = editor.document.getText();

    // Save range of selection (convert empty selection to active line)
    const selection = editor.selection;
    if (selection.isEmpty) {
      const line = editor.document.lineAt(selection.active.line);
      this.originalRange = new vscode.Range(line.range.start, line.range.end);
    } else {
      this.originalRange = new vscode.Range(selection.start, selection.end);
    }
    this.currentRange = new vscode.Range(this.originalRange.start, this.originalRange.end);

    vscode.commands.executeCommand('setContext', 'k-horizon.inInlineEditMode', true);

    // Show status bar message loading indicator
    const statusBarMessage = vscode.window.setStatusBarMessage('$(sync~spin) K-Horizon: Generating edit...');

    try {
      const systemInstruction = `You are a precise, token-efficient inline code edit assistant.
Modify the user's selected code based on their prompt.
You MUST output EXACTLY one SEARCH/REPLACE block containing the selected code in the SEARCH section, and the modified code in the REPLACE section.
Do not output any introductory text, summary, explanation, or conversational fluff.
Do NOT compromise on code quality or completeness to save tokens. Never use placeholders or comments like '// rest of code remains the same' to truncate code blocks. Always provide complete, working implementations.

Format:
<<<<<<< SEARCH
${context.selectionText}
=======
[modified code]
>>>>>>> REPLACE`;

      const userMessage = `File: ${context.relativePath}\nPrompt: ${prompt}\n\nSelected Code:\n${context.selectionText}`;

      // Call streaming LLM
      let fullResponse = '';
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'K-Horizon AI: Editing code...',
          cancellable: true
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => {
            this.rejectEdit();
          });

          fullResponse = await AIService.streamResponse(
            [{ role: 'user', content: userMessage, timestamp: Date.now() }],
            systemInstruction,
            (_streamToken) => {
              // We could stream token updates, but applying on completion is more stable.
            }
          );
        }
      );

      statusBarMessage.dispose();

      // Parse and apply diff
      const fileDiffs = DiffHandler.parseDiffs(fullResponse);
      let diffBlocks = Array.from(fileDiffs.values())[0]; // Take first parsed block

      // If parser failed to find file association but found a diff block, try fallback
      if (!diffBlocks || diffBlocks.length === 0) {
        // Fallback: search for diff block manually in output
        const searchMatch = fullResponse.indexOf('<<<<<<< SEARCH');
        const middleMatch = fullResponse.indexOf('=======');
        const endMatch = fullResponse.indexOf('>>>>>>> REPLACE');

        if (searchMatch !== -1 && middleMatch !== -1 && endMatch !== -1) {
          const searchContent = fullResponse.substring(searchMatch + 14, middleMatch).trim();
          const replaceContent = fullResponse.substring(middleMatch + 7, endMatch).trim();
          diffBlocks = [{ searchContent, replaceContent }];
        }
      }

      if (!diffBlocks || diffBlocks.length === 0) {
        // Fallback: If LLM outputted raw code without headers, treat the entire output as replacement
        const rawReplace = fullResponse.replace(/```[a-zA-Z]*\n/g, '').replace(/```/g, '').trim();
        diffBlocks = [{ searchContent: this.originalText, replaceContent: rawReplace }];
      }

      // Apply edit locally using editor's edit builder
      const success = await editor.edit(editBuilder => {
        editBuilder.replace(this.originalRange, diffBlocks[0].replaceContent);
      });

      if (success) {
        // Compute new range and track it for safe revert
        const startOffset = editor.document.offsetAt(this.originalRange.start);
        const newEndOffset = startOffset + diffBlocks[0].replaceContent.length;
        const newEndPosition = editor.document.positionAt(newEndOffset);
        this.currentRange = new vscode.Range(this.originalRange.start, newEndPosition);

        // Highlight only the added ranges
        try {
          const diffLines = DiffHandler.generateLineDiff(this.originalText, diffBlocks[0].replaceContent);
          const addedRanges: vscode.Range[] = [];
          let currentLine = this.originalRange.start.line;
          for (const line of diffLines) {
            if (line.type === 'normal') {
              currentLine++;
            } else if (line.type === 'added') {
              if (currentLine < editor.document.lineCount) {
                const lineObj = editor.document.lineAt(currentLine);
                addedRanges.push(lineObj.range);
              }
              currentLine++;
            }
          }
          editor.setDecorations(this.addedDecoration, addedRanges);
        } catch (decorErr) {
          // Fallback to highlighting the entire current range
          editor.setDecorations(this.addedDecoration, [this.currentRange]);
        }
        
        vscode.window.showInformationMessage('Edit applied. Press Enter to Accept, Escape to Undo.', 'Accept', 'View Diff', 'Undo')
          .then(selection => {
            if (selection === 'Accept') {
              this.acceptEdit();
            } else if (selection === 'View Diff') {
              this.showNativeDiff();
            } else if (selection === 'Undo') {
              this.rejectEdit();
            }
          });
      } else {
        vscode.window.showErrorMessage('Failed to apply edit inside document.');
        this.clearState();
      }

    } catch (err: any) {
      statusBarMessage.dispose();
      vscode.window.showErrorMessage(`Inline Edit failed: ${err.message}`);
      this.rejectEdit();
    }
  }

  private static acceptEdit() {
    if (!this.isEditActive || !this.activeEditor) return;
    this.activeEditor.setDecorations(this.addedDecoration, []);
    this.activeEditor.setDecorations(this.removedDecoration, []);
    vscode.window.showInformationMessage('AI changes accepted.');
    this.clearState();
  }

  private static async rejectEdit() {
    if (!this.isEditActive || !this.activeEditor) return;

    const editor = this.activeEditor;
    // Revert by replacing the current edit range with the original text.
    // This is safe regardless of any concurrent user typing — we only touch the range we modified.
    await editor.edit(editBuilder => {
      editBuilder.replace(this.currentRange, this.originalText);
    });

    editor.setDecorations(this.addedDecoration, []);
    editor.setDecorations(this.removedDecoration, []);
    vscode.window.showInformationMessage('AI changes reverted.');
    this.clearState();
  }

  private static clearState() {
    this.isEditActive = false;
    this.originalText = '';
    this.originalFileContent = '';
    this.activeEditor = undefined;
    vscode.commands.executeCommand('setContext', 'k-horizon.inInlineEditMode', false);
  }

  private static async showNativeDiff() {
    if (!this.activeEditor) return;
    const editor = this.activeEditor;
    const document = editor.document;
    const tempDir = os.tmpdir();
    const randomId = Math.random().toString(36).substring(7);
    const fileName = path.basename(document.uri.fsPath);
    const tempOriginalPath = path.join(tempDir, `k_horizon_orig_${randomId}_${fileName}`);
    const tempProposedPath = path.join(tempDir, `k_horizon_prop_${randomId}_${fileName}`);

    try {
      fs.writeFileSync(tempOriginalPath, this.originalFileContent, 'utf8');
      fs.writeFileSync(tempProposedPath, document.getText(), 'utf8');

      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(tempOriginalPath),
        vscode.Uri.file(tempProposedPath),
        `Diff: ${fileName} (AI Edit)`
      );

      // Offer acceptance again after opening the diff view
      vscode.window.showInformationMessage('Reviewing changes in diff editor. Would you like to accept or undo?', 'Accept', 'Undo')
        .then(selection => {
          if (selection === 'Accept') {
            this.acceptEdit();
          } else if (selection === 'Undo') {
            this.rejectEdit();
          }
        });
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to open diff editor: ${err.message}`);
    }
  }
}
