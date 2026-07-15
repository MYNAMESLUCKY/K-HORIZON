import { describe, expect, it, vi } from 'vitest';
import { AIService } from '../ai-service';
import * as vscode from 'vscode';
const workspace = vscode.workspace;

describe('AIService', () => {
  it('strips temperature from reasoning models to prevent API errors', async () => {
    const configMap = new Map<string, any>();
    configMap.set('provider', 'OpenAI');
    configMap.set('chatModel', 'o1-mini'); // A reasoning model
    configMap.set('apiKey', 'fake-api-key');

    const origGetConfig = workspace.getConfiguration;
    workspace.getConfiguration = () => ({
      get: (key: string) => configMap.get(key),
    } as any);

    const mockResponse = {
      ok: true,
      body: {
        getReader: () => {
          let count = 0;
          return {
            read: async () => {
              if (count++ === 0) {
                // Return a dummy SSE chunk
                const chunk = 'data: ' + JSON.stringify({
                  choices: [{ delta: { content: 'hello' } }]
                }) + '\n\n';
                return { value: Buffer.from(chunk), done: false };
              }
              return { value: undefined, done: true };
            },
            releaseLock: () => {}
          };
        }
      },
      headers: {
        get: () => 'text/event-stream'
      }
    };

    const origFetch = global.fetch;
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse as any);
    global.fetch = fetchSpy;

    try {
      await AIService.streamResponseDetailed(
        [{ role: 'user', content: 'test', timestamp: Date.now() }],
        'system instruction',
        () => {},
        'o1-mini',
        'OpenAI',
        0.5 // Pass temperature override
      );

      expect(fetchSpy).toHaveBeenCalled();
      const [, initArg] = fetchSpy.mock.calls[0];
      const parsedBody = JSON.parse(initArg.body);
      expect(parsedBody.temperature).toBeUndefined();
    } finally {
      global.fetch = origFetch;
      workspace.getConfiguration = origGetConfig;
    }
  });

  it('prunes systemInstruction/basePrompt and coalesced messages for Copilot provider to fit targetBudget', async () => {
    const configMap = new Map<string, any>();
    configMap.set('provider', 'Copilot');
    configMap.set('chatModel', 'copilot-gpt-4o');

    const origGetConfig = workspace.getConfiguration;
    workspace.getConfiguration = () => ({
      get: (key: string) => configMap.get(key),
    } as any);

    const mockModel = {
      maxInputTokens: 2000,
      sendRequest: vi.fn().mockImplementation(async () => {
        return {
          text: (async function* () {
            yield 'Mocked Copilot response';
          })()
        };
      })
    };

    const vscodeLm = vscode.lm;
    const origSelect = vscodeLm.selectChatModels;
    vscodeLm.selectChatModels = vi.fn().mockResolvedValue([mockModel]);

    try {
      const largeSystemInstruction = `
## System prompt headers and instructions
## Codebase Repository Map
${'a'.repeat(8000)}
## Gold-Standard Exemplar
${'b'.repeat(8000)}
`;
      
      const messages = [
        { role: 'user', content: 'hello', timestamp: Date.now() },
        { role: 'assistant', content: 'hi', timestamp: Date.now() },
        { role: 'user', content: 'test request', timestamp: Date.now() }
      ];

      await AIService.streamResponseDetailed(
        messages as any,
        largeSystemInstruction,
        () => {},
        'copilot-gpt-4o',
        'Copilot'
      );

      expect(mockModel.sendRequest).toHaveBeenCalled();
      const sentMessages = mockModel.sendRequest.mock.calls[0][0];
      const mergedContent = sentMessages.map((m: any) => m.content).join('\n');
      
      expect(mergedContent).not.toContain('## Codebase Repository Map');
      expect(mergedContent).not.toContain('## Gold-Standard Exemplar');
    } finally {
      workspace.getConfiguration = origGetConfig;
      vscodeLm.selectChatModels = origSelect;
    }
  });

  it('uses raw Gemini model IDs for the OpenAI-compatible chat endpoint', async () => {
    const configMap = new Map<string, any>();
    configMap.set('provider', 'Gemini');
    configMap.set('chatModel', 'gemini-1.5-flash');
    configMap.set('apiKey', 'fake-gemini-key');

    const origGetConfig = workspace.getConfiguration;
    workspace.getConfiguration = () => ({
      get: (key: string) => configMap.get(key),
    } as any);

    const mockResponse = {
      ok: true,
      body: {
        getReader: () => {
          let count = 0;
          return {
            read: async () => {
              if (count++ === 0) {
                const chunk = 'data: ' + JSON.stringify({
                  choices: [{ delta: { content: 'hello' } }]
                }) + '\n\n';
                return { value: Buffer.from(chunk), done: false };
              }
              return { value: undefined, done: true };
            },
          };
        }
      },
      headers: {
        get: () => 'text/event-stream'
      }
    };

    const origFetch = global.fetch;
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse as any);
    global.fetch = fetchSpy;

    try {
      await AIService.streamResponseDetailed(
        [{ role: 'user', content: 'test', timestamp: Date.now() }],
        'system instruction',
        () => {},
        'gemini-1.5-flash',
        'Gemini'
      );

      const [urlArg, initArg] = fetchSpy.mock.calls[0];
      const parsedBody = JSON.parse(initArg.body);
      expect(urlArg).toContain('/openai/chat/completions');
      expect(urlArg).not.toContain('?key=');
      expect(initArg.headers.Authorization).toBe('Bearer fake-gemini-key');
      expect(parsedBody.model).toBe('gemini-1.5-flash');
    } finally {
      global.fetch = origFetch;
      workspace.getConfiguration = origGetConfig;
    }
  });

  it('uses raw Gemini model IDs for autocomplete requests', async () => {
    const configMap = new Map<string, any>();
    configMap.set('provider', 'Gemini');
    configMap.set('autocompleteModel', 'gemini-1.5-flash');
    configMap.set('apiKey', 'fake-gemini-key');

    const origGetConfig = workspace.getConfiguration;
    workspace.getConfiguration = () => ({
      get: (key: string) => configMap.get(key),
    } as any);

    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'completion' } }]
      })
    };

    const origFetch = global.fetch;
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse as any);
    global.fetch = fetchSpy;

    try {
      const result = await AIService.getAutocomplete(
        'const value = ',
        ';',
        { isCancellationRequested: false } as any
      );

      const [urlArg, initArg] = fetchSpy.mock.calls[0];
      const parsedBody = JSON.parse(initArg.body);
      expect(result).toBe('completion');
      expect(urlArg).toContain('/openai/chat/completions');
      expect(urlArg).not.toContain('?key=');
      expect(initArg.headers.Authorization).toBe('Bearer fake-gemini-key');
      expect(parsedBody.model).toBe('gemini-1.5-flash');
    } finally {
      global.fetch = origFetch;
      workspace.getConfiguration = origGetConfig;
    }
  });

  it('sends native tool definitions for OpenAI-compatible providers', async () => {
    const configMap = new Map<string, any>();
    configMap.set('provider', 'OpenAI');
    configMap.set('chatModel', 'gpt-4o');
    configMap.set('apiKey', 'fake-api-key');

    const origGetConfig = workspace.getConfiguration;
    workspace.getConfiguration = () => ({
      get: (key: string) => configMap.get(key),
    } as any);

    const mockResponse = {
      ok: true,
      body: {
        getReader: () => {
          let count = 0;
          return {
            read: async () => {
              if (count++ === 0) {
                const chunk = 'data: ' + JSON.stringify({
                  choices: [{ delta: { content: '{"name":"read_file","arguments":{"file_path":"src/a.ts"}}' } }]
                }) + '\n\n';
                return { value: Buffer.from(chunk), done: false };
              }
              return { value: undefined, done: true };
            },
          };
        }
      },
      headers: {
        get: () => 'text/event-stream'
      }
    };

    const origFetch = global.fetch;
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse as any);
    global.fetch = fetchSpy;

    try {
      const result = await AIService.streamResponseDetailed(
        [{ role: 'user', content: 'read src/a.ts', timestamp: Date.now() }],
        'system instruction',
        () => {},
        'gpt-4o',
        'OpenAI',
        undefined,
        undefined,
        { enableTools: true }
      );

      const [, initArg] = fetchSpy.mock.calls[0];
      const parsedBody = JSON.parse(initArg.body);
      // Native tool definitions are now sent for all providers (Fix 1)
      expect(parsedBody.tools).toBeDefined();
      expect(Array.isArray(parsedBody.tools)).toBe(true);
      expect(parsedBody.tools.length).toBeGreaterThan(0);
      expect(parsedBody.tool_choice).toBe('auto');
    } finally {
      global.fetch = origFetch;
      workspace.getConfiguration = origGetConfig;
    }
  });

  it('normalizes Anthropic streamed native tool calls from input_json_delta fragments', async () => {
    const configMap = new Map<string, any>();
    configMap.set('provider', 'Anthropic');
    configMap.set('chatModel', 'claude-3-5-sonnet');
    configMap.set('apiKey', 'fake-anthropic-key');

    const origGetConfig = workspace.getConfiguration;
    workspace.getConfiguration = () => ({
      get: (key: string) => configMap.get(key),
    } as any);

    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'read_file',
          input: {}
        }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"file_path":"src/a.ts"}'
        }
      },
      { type: 'message_stop' }
    ];

    const mockResponse = {
      ok: true,
      body: {
        getReader: () => {
          let count = 0;
          return {
            read: async () => {
              if (count < events.length) {
                const chunk = 'data: ' + JSON.stringify(events[count++]) + '\n\n';
                return { value: Buffer.from(chunk), done: false };
              }
              return { value: undefined, done: true };
            },
          };
        }
      },
      headers: {
        get: () => 'text/event-stream'
      }
    };

    const origFetch = global.fetch;
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse as any);
    global.fetch = fetchSpy;

    try {
      const result = await AIService.streamResponseDetailed(
        [{ role: 'user', content: 'read src/a.ts', timestamp: Date.now() }],
        'system instruction',
        () => {},
        'claude-3-5-sonnet',
        'Anthropic',
        undefined,
        undefined,
        { enableTools: true }
      );

      const [, initArg] = fetchSpy.mock.calls[0];
      const parsedBody = JSON.parse(initArg.body);
      expect(parsedBody.tools).toBeDefined();
      expect(result.toolCalls).toEqual([
        {
          name: 'read_file',
          arguments: {
            file_path: 'src/a.ts'
          }
        }
      ]);
    } finally {
      global.fetch = origFetch;
      workspace.getConfiguration = origGetConfig;
    }
  });
});
