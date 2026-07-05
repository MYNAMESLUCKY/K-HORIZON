import * as vscode from 'vscode';
import { AIService } from './ai-service';

export class AutocompleteProvider implements vscode.InlineCompletionItemProvider {
  private lastRequestTime = 0;
  private debounceMs = 250; // Delay to wait for user to stop typing before calling LLM
  private cache = new Map<string, string>();

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | vscode.InlineCompletionItem[]> {
    
    // Check if autocomplete is enabled in settings
    const settings = AIService.getSettings();
    if (!settings.enableAutocomplete) {
      return [];
    }

    // Check if the trigger is normal typing (avoid triggering on imports or edits if unwanted)
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      // Debounce logic
      const now = Date.now();
      this.lastRequestTime = now;
      
      await new Promise(resolve => setTimeout(resolve, this.debounceMs));
      
      // If a newer keystroke has occurred, or user cancelled, abort this request
      if (this.lastRequestTime !== now || token.isCancellationRequested) {
        return [];
      }
    }

    const offset = document.offsetAt(position);
    const docText = document.getText();

    // Token-efficient context slicing
    // Grabbing last 4000 chars of prefix (approx 80-100 lines) and 1500 chars of suffix (approx 30 lines)
    const prefix = docText.substring(Math.max(0, offset - 4000), offset);
    const suffix = docText.substring(offset, Math.min(docText.length, offset + 1500));

    // Avoid calling LLM for empty files or when at trailing whitespace at the very start
    if (prefix.trim() === '' && suffix.trim() === '') {
      return [];
    }

    // Cache check to reduce token usage and return suggestions instantly
    const cacheKey = `${document.uri.fsPath}::${prefix.substring(prefix.length - 300)}||${suffix.substring(0, 300)}`;
    if (this.cache.has(cacheKey)) {
      const cachedText = this.cache.get(cacheKey)!;
      if (cachedText) {
        const range = new vscode.Range(position, position);
        return [new vscode.InlineCompletionItem(cachedText, range)];
      }
      return [];
    }

    try {
      const completionText = await AIService.getAutocomplete(prefix, suffix, token);
      
      if (token.isCancellationRequested) {
        return [];
      }

      // Store in cache (bounded to 200 entries)
      this.cache.set(cacheKey, completionText);
      if (this.cache.size > 200) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) this.cache.delete(firstKey);
      }

      if (!completionText.trim()) {
        return [];
      }

      // Create completion item
      const range = new vscode.Range(position, position);
      const completionItem = new vscode.InlineCompletionItem(completionText, range);
      
      // Add command to track completion acceptance if needed
      return [completionItem];
    } catch (e) {
      return [];
    }
  }
}
