import * as vscode from 'vscode';
import { Settings, ChatMessage } from './types';
import { ToolCall, ToolManager } from './tool-manager';

export interface AIStreamResult {
  text: string;
  toolCalls: ToolCall[];
  /**
   * Raw chain-of-thought / reasoning text from reasoning-capable models.
   * Always empty for non-reasoning models. Stripped from `text` automatically.
   * Callers MUST NOT feed this back into `chatHistory`.
   */
  reasoning: string;
}

interface StreamResponseOptions {
  enableTools?: boolean;
  /**
   * When true, reasoning tokens are also forwarded to `onToken` (so the UI can
   * render them in a collapsible "thinking" panel). Defaults to false so that
   * existing chat surfaces keep their current behaviour.
   */
  exposeReasoning?: boolean;
}

/**
 * Provider/model capabilities used to decide whether to send `tools` / `thinking`
 * payloads, and whether to parse the `reasoning_content` SSE channel.
 *
 * Heuristic matching — false positives are harmless (we just enable a feature
 * the model may ignore); false negatives silently disable reasoning. Update the
 * substring tables when new flagship models launch.
 */
export class ModelCapabilities {
  /** Model id contains any of these substrings → reasoning-capable. */
  private static readonly REASONING_MODEL_HINTS = [
    // OpenAI
    'o1', 'o3', 'o4', 'gpt-5', 'gpt-5-thinking',
    // Anthropic extended thinking
    'claude-3-7', 'claude-3.7', 'claude-sonnet-4', 'claude-opus-4', 'claude-4',
    // DeepSeek R-series
    'deepseek-r1', 'deepseek-reasoner',
    // Qwen reasoning
    'qwq', 'qwen-qwq', 'qwen3', 'qwen-3',
    // Google Gemini thinking
    'gemini-2.5', 'gemini-3',
  ];

  /** Model id contains any of these substrings → provider supports native `tools`. */
  private static readonly NATIVE_TOOL_MODEL_HINTS = [
    'gpt-4', 'gpt-4o', 'gpt-5', 'o1', 'o3',
    'claude-3', 'claude-4',
    'gemini-1.5', 'gemini-2', 'gemini-3',
  ];

  static supportsReasoning(modelId: string | undefined, provider: string | undefined): boolean {
    if (!modelId) return false;
    const m = modelId.toLowerCase();
    if (this.REASONING_MODEL_HINTS.some(h => m.includes(h.toLowerCase()))) return true;
    // OpenRouter / proxies forward reasoning for any model that advertises it.
    if (provider?.toLowerCase() === 'openrouter' && m.includes('r1')) return true;
    return false;
  }

  static supportsNativeTools(modelId: string | undefined, provider: string | undefined): boolean {
    if (!modelId) return ToolManager.providerSupportsNativeTools(provider);
    const m = modelId.toLowerCase();
    if (this.NATIVE_TOOL_MODEL_HINTS.some(h => m.includes(h.toLowerCase()))) return true;
    return ToolManager.providerSupportsNativeTools(provider);
  }
}

/**
 * Strip a `<think>…</think>` / `<reasoning>…</reasoning>` block (and any
 * Markdown-style `:::reasoning` block) from `text` and return both halves.
 *
 * This is a defensive post-pass: even when a model is asked to keep reasoning
 * inside `<think>`, it occasionally bleeds into the visible channel. The
 * downstream agent graph and tool parser MUST see reasoning-free text.
 */
export function splitReasoningFromText(text: string): { text: string; reasoning: string } {
  if (!text) return { text: '', reasoning: '' };
  const reasoningParts: string[] = [];
  const patterns: RegExp[] = [
    /<think>[\s\S]*?<\/think>/gi,
    /<reasoning>[\s\S]*?<\/reasoning>/gi,
    /<reasoning_summary>[\s\S]*?<\/reasoning_summary>/gi,
    /:::reasoning[\s\S]*?(?:\n:::|:::)/gi,
  ];
  let cleaned = text;
  for (const p of patterns) {
    const matches = cleaned.match(p);
    if (matches) reasoningParts.push(...matches);
    cleaned = cleaned.replace(p, '');
  }
  // Also strip a leading <think>-like block that some models emit unclosed.
  // Conservative: only matches when the *first* non-whitespace token is
  // `<think` or `<reasoning>` and the text never closes.
  if (!reasoningParts.length) {
    const m = cleaned.match(/^\s*<(?:think|reasoning)>[\s\S]+$/i);
    if (m && !m[0].includes('</think>') && !m[0].includes('</reasoning>')) {
      reasoningParts.push(m[0]);
      cleaned = cleaned.replace(m[0], '').trimStart();
    }
  }
  return { text: cleaned.trim(), reasoning: reasoningParts.join('\n').trim() };
}

export class AIService {
  public static getSettings(): Settings {
    const config = vscode.workspace.getConfiguration('k-horizon');
    return {
      provider: config.get('provider') || 'Gemini',
      apiKey: config.get('apiKey') || '',
      baseURL: config.get('baseURL') || '',
      chatModel: config.get('chatModel') || 'gemini-1.5-flash',
      plannerModel: config.get('plannerModel') || 'gemini-1.5-flash',
      coderModel: config.get('coderModel') || 'gemini-1.5-flash',
      autocompleteModel: config.get('autocompleteModel') || 'gemini-1.5-flash',
      visionModel: config.get('visionModel') || 'gemini-1.5-flash',
      enableAutocomplete: config.get('enableAutocomplete') !== false,
      maxContextTokens: config.get('maxContextTokens') || 131000,
      systemPrompt: config.get('systemPrompt') || '',
      customModels: config.get('customModels') || [],
    };
  }

  /**
   * Streams chat completions from the configured LLM provider.
   */
  /**
     * Performs a fetch with exponential backoff retry for transient errors (429, 5xx, network).
     * Uses up to 3 attempts with 500ms -> 1500ms -> 4500ms delays.
     */
    private static async fetchWithRetry(
      url: string,
      init: RequestInit,
      signal?: AbortSignal
    ): Promise<Response> {
      const maxAttempts = 3;
      let lastError: any;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal?.aborted) {
          throw new Error('Request aborted by user cancellation.');
        }
        try {
          const response = await fetch(url, { ...init, signal });
          // Retry on 429 (rate-limited) and 5xx (server errors)
          if (response.status === 429 || (response.status >= 500 && response.status < 600)) {
            if (attempt < maxAttempts - 1) {
              const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
              const delayMs = retryAfter > 0
                ? Math.min(retryAfter * 1000, 10000)
                : Math.min(500 * Math.pow(3, attempt), 5000);
              await new Promise(r => setTimeout(r, delayMs));
              continue;
            }
          }
          return response;
        } catch (err: any) {
          lastError = err;
          if (err.name === 'AbortError') throw err;
          if (attempt < maxAttempts - 1) {
            await new Promise(r => setTimeout(r, Math.min(500 * Math.pow(3, attempt), 5000)));
            continue;
          }
          throw err;
        }
      }
      throw lastError || new Error('fetchWithRetry: exhausted retries');
    }

    public static async streamResponse(
    messages: ChatMessage[],
    systemInstruction: string,
    onToken: (token: string) => void,
    modelOverride?: string,
    providerOverride?: string,
    tempOverride?: number,
    token?: vscode.CancellationToken
  ): Promise<string> {
    const result = await this.streamResponseDetailed(
      messages,
      systemInstruction,
      onToken,
      modelOverride,
      providerOverride,
      tempOverride,
      token
    );
    return result.text;
  }

  public static async streamResponseDetailed(
    messages: ChatMessage[],
    systemInstruction: string,
    onToken: (token: string) => void,
    modelOverride?: string,
    providerOverride?: string,
    tempOverride?: number,
    token?: vscode.CancellationToken,
    options: StreamResponseOptions = {}
  ): Promise<AIStreamResult> {
    const settings = this.getSettings();
    let provider = providerOverride || settings.provider;
    let apiKey = settings.apiKey;
    let model = modelOverride || settings.chatModel;
    let baseURL = settings.baseURL;

    // Resolve custom model configurations. IMPORTANT: when the caller passed an
    // explicit providerOverride (e.g. from a subagent profile), respect it and
    // only borrow the model's credential / endpoint from the custom entry —
    // do NOT silently switch the provider, otherwise subagent routing breaks
    // whenever a custom model name collides with a built-in model id.
    const customModel = settings.customModels?.find(m => m.modelId === model || m.name === model);
    if (customModel) {
      apiKey = customModel.apiKey || apiKey;
      baseURL = customModel.baseURL || baseURL;
      if (!providerOverride) {
        provider = customModel.provider || 'OpenAI';
        model = customModel.modelId;
      }
    }

    const basePrompt = settings.systemPrompt || systemInstruction;

    if (provider === 'Copilot') {
      let chatModelToUse: vscode.LanguageModelChat | undefined;
      try {
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: model });
        if (models && models.length > 0) {
          chatModelToUse = models[0];
        } else {
          // Fallback to any Copilot model
          const anyCopilot = await vscode.lm.selectChatModels({ vendor: 'copilot' });
          if (anyCopilot && anyCopilot.length > 0) {
            chatModelToUse = anyCopilot[0];
          }
        }
      } catch (err) {
        console.error("Error selecting Copilot chat model:", err);
      }

      if (!chatModelToUse) {
        // Fallback to any VS Code LM model
        try {
          const anyModel = await vscode.lm.selectChatModels({});
          if (anyModel && anyModel.length > 0) {
            chatModelToUse = anyModel[0];
          }
        } catch (err) {
          console.error("Error selecting fallback model:", err);
        }
      }

      if (!chatModelToUse) {
        throw new Error("No VS Code Language Models available. Please ensure the GitHub Copilot extension is installed and enabled.");
      }

      const lmMessages: vscode.LanguageModelChatMessage[] = [];
      if (basePrompt) {
        lmMessages.push(vscode.LanguageModelChatMessage.User(basePrompt));
      }
      for (const m of messages) {
        if (m.role === 'assistant') {
          lmMessages.push(vscode.LanguageModelChatMessage.Assistant(m.content));
        } else if (m.role === 'user') {
          lmMessages.push(vscode.LanguageModelChatMessage.User(m.content));
        }
      }

      const cts = new vscode.CancellationTokenSource();
      const response = await chatModelToUse.sendRequest(lmMessages, {}, cts.token);

      // The Copilot LM API interleaves reasoning and visible text in a single
      // `response.text` stream for thinking-capable models. We split after the
      // fact via `splitReasoningFromText`, which strips `<think>…</think>` and
      // `<reasoning>…</reasoning>` blocks out of the visible channel. Without
      // this pass, chain-of-thought leaks to the user and into chatHistory.
      let accumulatedText = '';
      for await (const chunk of response.text) {
        accumulatedText += chunk;
        if (options.exposeReasoning) {
          // Best-effort: pass the raw chunk through. Splitting happens once at
          // the end so we don't risk emitting a partial `<think>` token as
          // visible text and confusing the user mid-stream.
          onToken(chunk);
        }
      }
      const { text: visibleText, reasoning } = splitReasoningFromText(accumulatedText);
      if (!options.exposeReasoning) {
        // Replay only the visible portion so the UI is consistent with the
        // stored value. We append rather than replace because onToken is a
        // streaming callback that already pushed earlier chunks to the
        // webview; the webview handler is responsible for clearing/replacing
        // stale content if it wants strict overwrite semantics.
        onToken(visibleText);
      }
      return { text: visibleText, toolCalls: [], reasoning };
    }

    let url = '';
    let headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    let body: any = {};

    const apiMessages: any[] = messages.map(m => ({ role: m.role, content: m.content }));
    if (basePrompt && basePrompt.trim() !== '') {
      apiMessages.unshift({ role: 'system', content: basePrompt });
    }

    switch (provider) {
      case 'Gemini':
        const geminiBase = baseURL || 'https://generativelanguage.googleapis.com/v1beta';
        url = this.normalizeURL(geminiBase, 'Gemini');
        // Detect if the URL is the native Gemini endpoint (uses ?key=) or the OpenAI-compatible one
        const isNativeGemini = url.includes('generativelanguage.googleapis.com') && !url.includes('/openai/');
        if (isNativeGemini) {
          url = url.includes('?key=') ? url : `${url}?key=${apiKey}`;
        } else if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        body = {
          model: model.includes('/') ? model : `models/${model}`,
          messages: apiMessages,
          max_tokens: 16384,
          stream: true
        };
        break;

      case 'Ollama':
        const ollamaBase = baseURL || 'http://127.0.0.1:11434';
        url = this.normalizeURL(ollamaBase, 'Ollama');
        body = {
          model: model,
          messages: apiMessages,
          options: {
            num_predict: -1
          },
          stream: true
        };
        break;

      case 'OpenAI':
        const openaiBase = baseURL || 'https://api.openai.com/v1';
        url = this.normalizeURL(openaiBase, 'OpenAI');
        headers['Authorization'] = `Bearer ${apiKey}`;
        body = {
          model: model,
          messages: apiMessages,
          max_tokens: 16384,
          stream: true
        };
        break;

      case 'Anthropic':
        const anthropicBase = baseURL || 'https://api.anthropic.com/v1';
        url = this.normalizeURL(anthropicBase, 'Anthropic');
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        headers['anthropic-beta'] = 'prompt-caching-2024-07-31';
        // Anthropic supports prompt caching: cache system prompt, last turn prefix, and latest user message
        const anthropicMessages = messages
          .filter(m => m.role !== 'system')
          .map((m, idx, arr) => {
            const msg: any = {
              role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
              content: m.content,
            };
            const isLast = idx === arr.length - 1;
            const isPrevTurn = idx === arr.length - 3 && arr.length >= 3;
            if (isLast || isPrevTurn) {
              msg.cache_control = { type: 'ephemeral' };
            }
            return msg;
          });
        body = {
          model: model,
          system: basePrompt && basePrompt.trim() !== ''
            ? [{ type: 'text', text: basePrompt, cache_control: { type: 'ephemeral' } }]
            : undefined,
          messages: anthropicMessages,
          max_tokens: 8192,
          stream: true
        };
        break;

      case 'OpenRouter':
        const openRouterBase = baseURL || 'https://openrouter.ai/api/v1';
        url = this.normalizeURL(openRouterBase, 'OpenRouter');
        headers['Authorization'] = `Bearer ${apiKey}`;
        headers['HTTP-Referer'] = 'https://github.com/k-horizon/k-horizon';
        headers['X-Title'] = 'K-HORIZON';

        const isClaude = model.toLowerCase().includes('claude-3');
        if (isClaude) {
          headers['openrouter-beta'] = 'prompt-caching';
          const openRouterMessages: any[] = [];
          if (basePrompt && basePrompt.trim() !== '') {
            openRouterMessages.push({
              role: 'system',
              content: basePrompt,
              cache_control: { type: 'ephemeral' }
            });
          }
          messages
            .filter(m => m.role !== 'system')
            .forEach((m, idx, arr) => {
              const msg: any = {
                role: m.role,
                content: m.content
              };
              const isLast = idx === arr.length - 1;
              const isPrevTurn = idx === arr.length - 3 && arr.length >= 3;
              if (isLast || isPrevTurn) {
                msg.cache_control = { type: 'ephemeral' };
              }
              openRouterMessages.push(msg);
            });

          body = {
            model: model,
            messages: openRouterMessages,
            max_tokens: 16384,
            stream: true
          };
        } else {
          body = {
            model: model,
            messages: apiMessages,
            max_tokens: 16384,
            stream: true
          };
        }
        break;

      case 'Custom':
        url = this.normalizeURL(baseURL, 'Custom');
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        body = {
          model: model,
          messages: apiMessages,
          max_tokens: 16384,
          stream: true
        };
        break;
    }

    if (tempOverride !== undefined && tempOverride !== null) {
      body.temperature = tempOverride;
    }

    const useNativeTools = options.enableTools && ModelCapabilities.supportsNativeTools(model, provider);
    if (useNativeTools) {
      if (provider === 'Anthropic') {
        body.tools = ToolManager.getNativeToolDefinitions('anthropic');
        body.tool_choice = { type: 'auto' };
        // Enable extended thinking on Claude 3.7+/4 when the model id suggests
        // a reasoning-capable variant. Anthropic requires `budget_tokens` to
        // be at least 1024 and strictly less than `max_tokens`. We reserve
        // 1/4 of the budget for thinking.
        if (ModelCapabilities.supportsReasoning(model, provider)) {
          const thinkingBudget = Math.max(1024, Math.floor((body.max_tokens || 8192) / 4));
          body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
          // Anthropic requires `max_tokens` > budget_tokens when thinking is on.
          body.max_tokens = Math.max(body.max_tokens || 8192, thinkingBudget + 4096);
        }
      } else {
        body.tools = ToolManager.getNativeToolDefinitions('openai');
        body.tool_choice = 'auto';
        // OpenAI o-series / gpt-5 use `reasoning_effort` instead of (or in
        // addition to) `temperature`. Surface the option so users can opt in.
        if (ModelCapabilities.supportsReasoning(model, provider) && tempOverride === undefined) {
          // No temperature override → ask for "medium" reasoning effort. If
          // the caller already pinned a temperature we assume they want
          // minimal reasoning (a fast deterministic answer).
          body.reasoning_effort = 'medium';
        }
      }
    }

    const maxStreamAttempts = 3;
    let lastStreamError: any;

    for (let streamAttempt = 0; streamAttempt < maxStreamAttempts; streamAttempt++) {
      if (token?.isCancellationRequested) {
        throw new Error('Request aborted by user cancellation.');
      }

      const controller = new AbortController();
      if (token) {
        token.onCancellationRequested(() => {
          controller.abort();
        });
      }

      try {
        const response = await this.fetchWithRetry(url, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body),
        }, controller.signal);

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errText || response.statusText}`);
        }

        if (!response.body) {
          throw new Error('Response body is null');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulatedText = '';
        let accumulatedReasoning = '';
        let buffer = '';
        let streamFinished = false;
        const openAIToolCallParts = new Map<number, { id?: string; name?: string; arguments: string }>();
        const anthropicToolCallParts = new Map<number, { id?: string; name?: string; arguments: string }>();

        // Clear any previous token progress if we are retrying
        if (streamAttempt > 0) {
          onToken('\n\n🔄 **Network disruption detected. Retrying generation...**\n');
        }

        while (true) {
          if (token?.isCancellationRequested) {
            throw new Error('Request aborted by user cancellation.');
          }

          let chunk;
          try {
            chunk = await reader.read();
          } catch (streamErr: any) {
            console.warn('AI Service: stream reading terminated or failed:', streamErr);
            if (streamFinished && accumulatedText.trim().length > 0) {
              break; // Gracefully return if we know the stream finished
            }
            throw new Error(`Stream cut off prematurely: ${streamErr.message || 'connection lost'}`);
          }

          const { done, value } = chunk;
          if (done) {
            streamFinished = true;
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // Keep the last incomplete line in buffer
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (provider === 'Ollama') {
              try {
                const data = JSON.parse(trimmed);
                if (data.done === true) {
                  streamFinished = true;
                }
                // Ollama exposes thinking-capable models' reasoning in a
                // separate `message.thinking` field. Capture it but never
                // stream it as visible text.
                if (data.message && typeof data.message.thinking === 'string' && data.message.thinking.length > 0) {
                  accumulatedReasoning += data.message.thinking;
                  if (options.exposeReasoning) onToken(data.message.thinking);
                }
                if (data.message && data.message.content) {
                  const token = data.message.content;
                  accumulatedText += token;
                  onToken(token);
                }
              } catch (e) {
                // Ignore partial line parses
              }
            } else if (provider === 'Anthropic') {
              if (trimmed.startsWith('data:')) {
                const sseData = trimmed.slice(5).trim();
                if (sseData === '[DONE]') continue;
                try {
                  const data = JSON.parse(sseData);
                  if (data.type === 'message_stop' || data.type === 'content_block_stop') {
                    streamFinished = true;
                  }
                  // ── Anthropic thinking blocks ──────────────────────────
                  // Extended thinking emits `type: "thinking"` start blocks
                  // (with a signature) and `type: "thinking_delta"` deltas
                  // with the actual reasoning text. Capture and divert to
                  // the reasoning channel; do NOT push to onToken.
                  if (data.type === 'content_block_start' && data.content_block?.type === 'thinking') {
                    // No-op; signature arrives in a separate delta.
                  }
                  if (data.type === 'content_block_delta' && data.delta?.type === 'thinking_delta') {
                    const thinkingText = data.delta.thinking || '';
                    if (thinkingText) {
                      accumulatedReasoning += thinkingText;
                      if (options.exposeReasoning) onToken(thinkingText);
                    }
                    continue;
                  }
                  if (data.type === 'content_block_delta' && data.delta?.type === 'signature_delta') {
                    // Signature is required when re-sending a thinking block
                    // in a multi-turn conversation. We don't preserve it
                    // here, but skipping past it keeps the SSE loop healthy.
                    continue;
                  }
                  // ── Anthropic tool_use blocks ──────────────────────────
                  if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
                    anthropicToolCallParts.set(data.index || 0, {
                      id: data.content_block.id,
                      name: data.content_block.name,
                      arguments: data.content_block.input ? JSON.stringify(data.content_block.input) : '',
                    });
                  }
                  if (data.type === 'content_block_delta' && data.delta && data.delta.text) {
                    const token = data.delta.text;
                    accumulatedText += token;
                    onToken(token);
                  }
                  if (data.type === 'content_block_delta' && data.delta?.type === 'input_json_delta') {
                    const index = data.index || 0;
                    const existing = anthropicToolCallParts.get(index) || { arguments: '' };
                    existing.arguments += data.delta.partial_json || '';
                    anthropicToolCallParts.set(index, existing);
                  }
                } catch (e) { }
              }
            } else {
              // OpenAI / Gemini / OpenRouter / Custom SSE format
              if (trimmed.startsWith('data:')) {
                const sseData = trimmed.slice(5).trim();
                if (sseData === '[DONE]') {
                  streamFinished = true;
                  continue;
                }
                try {
                  const data = JSON.parse(sseData);
                  const choice = data.choices?.[0];
                  if (choice && (choice.finish_reason === 'stop' || choice.finish_reason === 'length' || choice.finish_reason === 'tool_calls')) {
                    streamFinished = true;
                  }
                  // ── Reasoning channel ─────────────────────────────────
                  // DeepSeek R1, OpenRouter reasoning models, and some
                  // OpenAI-compatible proxies surface reasoning in a
                  // separate `delta.reasoning_content` (DeepSeek) or
                  // `delta.reasoning` (OpenAI o-series with reasoning
                  // effort in the streaming API). Capture, don't surface.
                  const reasoningDelta =
                    choice?.delta?.reasoning_content ??
                    choice?.delta?.reasoning ??
                    null;
                  if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
                    accumulatedReasoning += reasoningDelta;
                    if (options.exposeReasoning) onToken(reasoningDelta);
                  }
                  // ── Visible text channel ─────────────────────────────
                  if (choice && choice.delta && choice.delta.content !== null && choice.delta.content !== undefined) {
                    const token = choice.delta.content;
                    accumulatedText += token;
                    onToken(token);
                  }
                  // ── Gemini thought parts (thought summaries) ─────────
                  // Some Gemini proxies surface `parts[].thought: true`
                  // alongside the text parts. We can't reach them through
                  // the OpenAI-compat SSE shape, so this branch stays
                  // here as a placeholder for when we move to the native
                  // Gemini streaming API.
                  if (choice?.delta?.tool_calls) {
                    for (const toolCallDelta of choice.delta.tool_calls) {
                      const index = toolCallDelta.index ?? 0;
                      const existing = openAIToolCallParts.get(index) || { arguments: '' };
                      if (toolCallDelta.id) existing.id = toolCallDelta.id;
                      if (toolCallDelta.function?.name) existing.name = toolCallDelta.function.name;
                      if (toolCallDelta.function?.arguments) existing.arguments += toolCallDelta.function.arguments;
                      openAIToolCallParts.set(index, existing);
                    }
                  }
                } catch (e) { }
              }
            }
          }
        }

        // If we reached here, the stream finished successfully!
        // Defensive: even when the provider separates reasoning into its own
        // channel, models occasionally bleed <think>/<reasoning> blocks into
        // the visible text. Strip them here so the tool-call parser and the
        // agent graph never see them.
        const { text: visibleText, reasoning: strippedReasoning } = splitReasoningFromText(accumulatedText);
        const combinedReasoning = (accumulatedReasoning || '') + (strippedReasoning || '');

        const nativeToolCalls = provider === 'Anthropic'
          ? Array.from(anthropicToolCallParts.values()).map(call => ({
              id: call.id,
              name: call.name,
              input: call.arguments,
            }))
          : Array.from(openAIToolCallParts.values()).map(call => ({
              id: call.id,
              function: {
                name: call.name,
                arguments: call.arguments,
              },
            }));
        return {
          text: visibleText,
          toolCalls: ToolManager.normalizeNativeToolCalls(nativeToolCalls),
          reasoning: combinedReasoning,
        };

      } catch (error: any) {
        lastStreamError = error;
        // If it's a cancellation error, do not retry
        if (error.message === 'Request aborted by user cancellation.' || error.name === 'AbortError') {
          throw error;
        }

        if (streamAttempt < maxStreamAttempts - 1) {
          const delayMs = 1000 * (streamAttempt + 1);
          console.warn(`Stream attempt ${streamAttempt + 1} failed. Retrying in ${delayMs}ms... Error:`, error);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
      }
    }

    // Surface the final error if all retry attempts are exhausted
    vscode.window.showErrorMessage(`K-Horizon AI error: ${lastStreamError.message}`);
    throw lastStreamError;
  }

  /**
   * Fetches inline completions (ghost-text autocomplete) using FIM (Fill-in-the-Middle).
   */
  public static async getAutocomplete(
    prefix: string,
    suffix: string,
    cancelToken: vscode.CancellationToken
  ): Promise<string> {
    // Autocomplete prompts must be extremely brief. We instruct the model to only output the completed code block.
    const systemPrompt = `You are a high-performance inline code auto-complete assistant.
Your job is to complete the code between <PRE> and <SUF>.
Format:
The user will provide:
<PRE>
[code before cursor]
</PRE>
<SUF>
[code after cursor]
</SUF>
You MUST output ONLY the direct continuation of the code that should be inserted at the cursor.
Rules:
1. DO NOT wrap the output in markdown code blocks.
2. DO NOT write explanations, intros, or comments.
3. Match indentation, braces, and line breaks exactly.
4. Output should be empty if no completion makes sense.`;

    const userPrompt = `<PRE>\n${prefix}\n</PRE>\n<SUF>\n${suffix}\n</SUF>`;

    const settings = this.getSettings();
    let provider = settings.provider;
    let apiKey = settings.apiKey;
    let model = settings.autocompleteModel;
    let baseURL = settings.baseURL;

    // Resolve custom model configurations
    const customModel = settings.customModels?.find(m => m.modelId === model || m.name === model);
    if (customModel) {
      provider = customModel.provider || 'OpenAI';
      apiKey = customModel.apiKey || '';
      model = customModel.modelId;
      baseURL = customModel.baseURL;
    }

    if (provider === 'Copilot') {
      try {
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-3.5-turbo' });
        const chatModelToUse = models[0] || (await vscode.lm.selectChatModels({ vendor: 'copilot' }))[0];
        if (!chatModelToUse) return '';

        const lmMessages = [
          vscode.LanguageModelChatMessage.User(systemPrompt),
          vscode.LanguageModelChatMessage.User(userPrompt)
        ];

        const response = await chatModelToUse.sendRequest(lmMessages, {}, cancelToken);
        let text = '';
        for await (const chunk of response.text) {
          text += chunk;
        }
        return text;
      } catch (e) {
        console.error('Copilot autocomplete error:', e);
        return '';
      }
    }

    let url = '';
    let headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    let body: any = {};

    switch (provider) {
      case 'Gemini':
        const geminiBase = baseURL || 'https://generativelanguage.googleapis.com/v1beta';
        const normGemini = this.normalizeURL(geminiBase, 'Gemini');
        url = normGemini.includes('?key=') ? normGemini : `${normGemini}?key=${apiKey}`;
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        body = {
          model: model.includes('/') ? model : `models/${model}`,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 128,
          temperature: 0.1,
          stream: false
        };
        break;

      case 'Ollama':
        const ollamaBase = baseURL || 'http://127.0.0.1:11434';
        url = this.normalizeURL(ollamaBase, 'Ollama');
        body = {
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          options: {
            num_predict: 128,
            temperature: 0.1
          },
          stream: false
        };
        break;

      case 'OpenAI':
        const openaiBase = baseURL || 'https://api.openai.com/v1';
        url = this.normalizeURL(openaiBase, 'OpenAI');
        headers['Authorization'] = `Bearer ${apiKey}`;
        body = {
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 128,
          temperature: 0.1,
          stream: false
        };
        break;

      case 'Anthropic':
        const anthropicBase = baseURL || 'https://api.anthropic.com/v1';
        url = this.normalizeURL(anthropicBase, 'Anthropic');
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        body = {
          model: model,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          max_tokens: 128,
          temperature: 0.1,
          stream: false
        };
        break;

      case 'OpenRouter':
        const openRouterBase = baseURL || 'https://openrouter.ai/api/v1';
        url = this.normalizeURL(openRouterBase, 'OpenRouter');
        headers['Authorization'] = `Bearer ${apiKey}`;
        body = {
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 128,
          temperature: 0.1,
          stream: false
        };
        break;

      case 'Custom':
        url = this.normalizeURL(baseURL, 'Custom');
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        body = {
          model: model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          max_tokens: 128,
          temperature: 0.1,
          stream: false
        };
        break;
    }

    try {
      if (cancelToken.isCancellationRequested) return '';

      const response = await this.fetchWithRetry(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) return '';
      const data: any = await response.json();

      if (cancelToken.isCancellationRequested) return '';

      let text = '';
      if (provider === 'Ollama') {
        text = data.message?.content || '';
      } else if (provider === 'Anthropic') {
        text = data.content?.[0]?.text || '';
      } else {
        text = data.choices?.[0]?.message?.content || '';
      }

      return text;
    } catch (e) {
      return '';
    }
  }

  /**
   * Calls the Ollama model gpt-oss:120b-cloud to generate a semantic summary/outline of a large file.
   */
  public static async generateSummary(relativePath: string, fileContent: string): Promise<string> {
    const settings = this.getSettings();
    const model = settings.plannerModel || settings.chatModel || 'gemini-1.5-flash';
    const provider = settings.provider || 'Gemini';

    const systemPrompt = `You are a high-performance codebase summarizer.
Your goal is to compress the provided source code file into a dense, token-efficient summary.
Rules:
1. Retain all import setups, class names, exported interfaces, and method signatures.
2. Replace long function implementation bodies with a simple comment describing what they do.
3. Cut all verbose internal comments.
4. Output ONLY the compressed structural outline of the code. No explanations.`;

    const userPrompt = `File: ${relativePath}\n\nContent:\n${fileContent}`;

    try {
      const result = await this.streamResponseDetailed(
        [{ role: 'user', content: userPrompt, timestamp: Date.now() }],
        systemPrompt,
        () => {},
        model,
        provider,
        0.1
      );
      // Reasoning-capable summarizers (o1, R1) emit a long thinking preamble
      // that, if injected back into the RAG context, would poison future
      // prompts. Strip it before returning.
      return splitReasoningFromText(result.text).text;
    } catch (e: any) {
      console.error(`Failed to generate summary using ${provider} (${model}):`, e);
      return ''; // Fallback to empty if LLM summary fails
    }
  }

  /**
   * Estimates token usage (roughly 4 characters per token).
   */
  public static estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Normalizes custom endpoints so they align with required API formats.
   */
  private static normalizeURL(url: string, provider: string): string {
    if (!url) return '';
    let result = url.trim();

    // Ensure we don't have trailing slash
    if (result.endsWith('/')) {
      result = result.slice(0, -1);
    }

    if (provider === 'Ollama') {
      if (!result.endsWith('/api/chat') && !result.endsWith('/api/generate')) {
        result += '/api/chat';
      }
    } else if (provider === 'Anthropic') {
      if (!result.endsWith('/v1/messages') && !result.endsWith('/messages')) {
        result += '/messages';
      }
    } else if (provider === 'Gemini') {
      if (!result.includes('/openai/chat/completions') && !result.includes('/v1beta')) {
        result += '/v1beta/openai/chat/completions';
      } else if (result.endsWith('/v1beta')) {
        result += '/openai/chat/completions';
      }
    } else {
      // Default to OpenAI compatibility layout (OpenAI / OpenRouter / Custom)
      if (!result.endsWith('/chat/completions')) {
        if (result.endsWith('/v1')) {
          result += '/chat/completions';
        } else {
          result += '/v1/chat/completions';
        }
      }
    }
    return result;
  }

  public static async analyzeImage(
    base64Image: string,
    mimeType: string,
    prompt: string
  ): Promise<string> {
    const settings = this.getSettings();
    let provider = settings.provider;
    let apiKey = settings.apiKey;
    let model = settings.visionModel || settings.chatModel || 'gemini-1.5-flash';
    let baseURL = settings.baseURL;

    if (provider === 'Copilot') {
      if (model.startsWith('gpt-')) {
        provider = 'OpenAI';
      } else if (model.startsWith('claude-')) {
        provider = 'Anthropic';
      } else if (model.startsWith('gemini-')) {
        provider = 'Gemini';
      }
    }

    const customModel = settings.customModels?.find(m => m.modelId === model || m.name === model);
    if (customModel) {
      apiKey = customModel.apiKey || apiKey;
      baseURL = customModel.baseURL || baseURL;
      provider = customModel.provider || provider;
      model = customModel.modelId;
    }

    let url = '';
    let headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    let body: any = {};

    switch (provider) {
      case 'Gemini':
        const geminiBase = baseURL || 'https://generativelanguage.googleapis.com/v1beta';
        url = this.normalizeURL(geminiBase, 'Gemini');
        const isNativeGemini = url.includes('generativelanguage.googleapis.com') && !url.includes('/openai/');
        if (isNativeGemini) {
          url = url.includes('?key=') ? url : `${url}?key=${apiKey}`;
        } else if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        body = {
          model: model.includes('/') ? model : `models/${model}`,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
              ]
            }
          ],
          max_tokens: 4096,
          stream: false
        };
        break;

      case 'OpenAI':
      case 'OpenRouter':
      case 'Custom':
        const openaiBase = baseURL || (provider === 'OpenRouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');
        url = this.normalizeURL(openaiBase, provider);
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        body = {
          model: model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
              ]
            }
          ],
          max_tokens: 4096,
          stream: false
        };
        break;

      case 'Anthropic':
        const anthropicBase = baseURL || 'https://api.anthropic.com';
        url = this.normalizeURL(anthropicBase, 'Anthropic');
        if (apiKey) {
          headers['x-api-key'] = apiKey;
        }
        headers['anthropic-version'] = '2023-06-01';
        body = {
          model: model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mimeType,
                    data: base64Image
                  }
                }
              ]
            }
          ],
          max_tokens: 4096
        };
        break;

      default:
        const fallbackBase = 'https://generativelanguage.googleapis.com/v1beta';
        url = this.normalizeURL(fallbackBase, 'Gemini');
        if (apiKey) {
          url = `${url}?key=${apiKey}`;
        }
        body = {
          model: 'models/gemini-1.5-flash',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
              ]
            }
          ],
          max_tokens: 4096,
          stream: false
        };
    }

    try {
      const response = await this.fetchWithRetry(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Vision API error HTTP ${response.status}: ${errText}`);
      }

      const resJSON = await response.json();
      if (provider === 'Anthropic') {
        return resJSON?.content?.[0]?.text || '';
      } else {
        return resJSON?.choices?.[0]?.message?.content || '';
      }
    } catch (err: any) {
      console.error('Vision analysis failed:', err);
      return `[Vision Error]: ${err.message}`;
    }
  }
}
