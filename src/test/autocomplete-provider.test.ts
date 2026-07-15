import { describe, expect, it, vi } from 'vitest';
import { AutocompleteProvider } from '../autocomplete-provider';
import { AIService } from '../ai-service';
import * as vscode from 'vscode';

describe('AutocompleteProvider', () => {
  it('performs client-side prefix-matching and returns instantly without network call', async () => {
    // 1. Enable autocomplete in settings
    const origGetSettings = AIService.getSettings;
    AIService.getSettings = () => ({
      enableAutocomplete: true,
      chatModel: 'fake-model',
      apiKey: 'fake-key',
    } as any);

    const provider = new AutocompleteProvider();

    // Mock document
    const mockDocument1 = {
      uri: vscode.Uri.file('/src/test.ts'),
      offsetAt: () => 10,
      getText: () => 'const foo = 42;',
    } as any;

    const mockPosition1 = new vscode.Position(0, 10);
    const mockContext = { triggerKind: vscode.InlineCompletionTriggerKind.Invoke } as any;
    const mockToken = { isCancellationRequested: false } as any;

    // Spy on AIService.getAutocomplete to return a pre-determined completion
    const getAutocompleteSpy = vi.spyOn(AIService, 'getAutocomplete').mockResolvedValue(' = 42;');

    // First call: calls the LLM autocomplete service
    const res1 = await provider.provideInlineCompletionItems(
      mockDocument1,
      mockPosition1,
      mockContext,
      mockToken
    );

    expect(getAutocompleteSpy).toHaveBeenCalledTimes(1);
    const items1 = res1 as any;
    expect(items1).toHaveLength(1);
    expect(items1[0].insertText).toBe(' = 42;');

    // Reset spy call count
    getAutocompleteSpy.mockClear();

    // Second call: user has typed ' ' (space), prefix matches!
    const mockDocument2 = {
      uri: vscode.Uri.file('/src/test.ts'),
      offsetAt: () => 11,
      getText: () => 'const foo  = 42;',
    } as any;
    const mockPosition2 = new vscode.Position(0, 11);

    const res2 = await provider.provideInlineCompletionItems(
      mockDocument2,
      mockPosition2,
      mockContext,
      mockToken
    );

    // Should NOT call AIService.getAutocomplete (network call)
    expect(getAutocompleteSpy).not.toHaveBeenCalled();
    const items2 = res2 as any;
    expect(items2).toHaveLength(1);
    // Slices off the typed space, returns the remaining suggestion
    expect(items2[0].insertText).toBe('= 42;');

    // Clean up
    AIService.getSettings = origGetSettings;
  });
});
