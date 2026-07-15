import { StateGraph, Annotation, START, END, MemorySaver } from '@langchain/langgraph';
import { AIService } from './ai-service';
import { ToolManager, ToolCall } from './tool-manager';
import { detectVerificationCommands } from './verification-commands';
import { ChatMessage } from './types';
import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceRoot } from './workspace-utils';
import { AgentTrace } from './agent-trace';
import { AgentLearningManager } from './learning-manager';
import { SUBAGENTS, isToolAllowedForSubagent, type SubagentId } from './subagents/registry';
import * as vscode from 'vscode';

// ─────────────────────────────────────────────────────────────
// 1. Agent State Schema
// ─────────────────────────────────────────────────────────────

/**
 * Typed state for the K-Horizon agent graph.
 *
 * IMPORTANT: The conversation history field is named `chatHistory` (NOT `messages`)
 * to avoid colliding with @langchain/core's internal `messages` channel validation,
 * which throws "model output must contain either output text or tool calls" when it
 * encounters plain {role, content} objects instead of LangChain AIMessage instances.
 */
export const AgentState = Annotation.Root({
  /** Full conversation history (user + assistant + tool results). */
  chatHistory: Annotation<ChatMessage[]>({
    reducer: (existing, incoming) => {
      if (!incoming) return existing;
      return existing.concat(incoming);
    },
    default: () => [],
  }),

  /** System instruction prompt. */
  systemInstruction: Annotation<string>({
    reducer: (_, v) => v,
    default: () => '',
  }),

  /** Model configuration override from agent profile. */
  modelConfig: Annotation<{ modelId?: string; provider?: string; temperature?: number }>({
    reducer: (_, v) => v,
    default: () => ({}),
  }),

  /** Streaming token callback – passed from sidebar provider. */
  onToken: Annotation<((token: string) => void) | null>({
    reducer: (_, v) => v,
    default: () => null,
  }),

  /** Whether the agent is still running (cancellation flag). */
  isRunning: Annotation<boolean>({
    reducer: (_, v) => v,
    default: () => true,
  }),

  /** Dynamic cancellation checker callback. */
  checkCancellation: Annotation<(() => boolean) | null>({
    reducer: (_, v) => v,
    default: () => null,
  }),

  /** Current loop iteration. */
  loopCount: Annotation<number>({
    reducer: (_, v) => v,
    default: () => 0,
  }),

  /** Maximum allowed loop iterations. */
  maxLoops: Annotation<number>({
    reducer: (_, v) => v,
    default: () => 100,
  }),

  /** Whether to auto-approve tool execution. */
  autoApprove: Annotation<boolean>({
    reducer: (_, v) => v,
    default: () => true,
  }),

  /** Whether step-debug mode is enabled. */
  stepDebug: Annotation<boolean>({
    reducer: (_, v) => v,
    default: () => false,
  }),

  /** Whether auto-compile self-healing is enabled. */
  autoCompile: Annotation<boolean>({
    reducer: (_, v) => v,
    default: () => false,
  }),

  /** Whether auto-test self-healing is enabled. */
  autoTest: Annotation<boolean>({
    reducer: (_, v) => v,
    default: () => false,
  }),

  /** Detected compile command (e.g. "npm run compile"). */
  compileCommand: Annotation<string>({
    reducer: (_, v) => v,
    default: () => 'npm run compile',
  }),

  /** Detected test command (e.g. "npm run test"). */
  testCommand: Annotation<string>({
    reducer: (_, v) => v,
    default: () => 'npm run test',
  }),

  /** Number of self-healing fix attempts for compile phase (own budget of 3). */
  compileHealAttempts: Annotation<number>({
    reducer: (_, v) => v,
    default: () => 0,
  }),

  /** Number of self-healing fix attempts for test phase (own budget of 3). */
  testHealAttempts: Annotation<number>({
    reducer: (_, v) => v,
    default: () => 0,
  }),

  /**
   * @deprecated Use `compileHealAttempts` / `testHealAttempts` instead.
   * Kept for backward compatibility with persisted checkpointer state.
   * New writes go to the split fields above.
   */
  healAttempts: Annotation<number>({
    reducer: (_, v) => v,
    default: () => 0,
  }),

  /** Counts consecutive text-only responses during a self-heal fix loop.
   *  When this exceeds 2 we force the agent into "summarize and ask" mode
   *  instead of burning another turn re-prompting for tool calls. */
  consecutiveTextOnlyHealResponses: Annotation<number>({
    reducer: (_, v) => v,
    default: () => 0,
  }),

  /** Number of consecutive times repromptToolCall has been invoked without
   *  the agent producing a tool call. Used to break text-only reprompt loops. */
  consecutiveReprompts: Annotation<number>({
    reducer: (_, v) => v,
    default: () => 0,
  }),

  /** Number of consecutive times continueUnfinishedTasks has been invoked
   *  without the agent completing any task. Used to break task-reprompt loops. */
  continueTaskReprompts: Annotation<number>({
    reducer: (_, v) => v,
    default: () => 0,
  }),

  /**
   * Accumulated final response text.
   * Self-heal suffix strings (starting with \n\n✨ or \n\n❌) are concatenated;
   * any other value (a new LLM response) replaces the previous one.
   */
  finalResponse: Annotation<string>({
    reducer: (existing, incoming) => {
      if (!incoming) return existing;
      if (incoming.startsWith('\n\n✨') || incoming.startsWith('\n\n❌')) {
        return existing + incoming;
      }
      return incoming;
    },
    default: () => '',
  }),

  /** Workspace root path. */
  workspaceRoot: Annotation<string>({
    reducer: (_, v) => v,
    default: () => '',
  }),

  /** Durable trace run id for this execution. */
  runId: Annotation<string>({
    reducer: (_, v) => v,
    default: () => '',
  }),

  /** Chat session id for trace correlation. */
  sessionId: Annotation<string>({
    reducer: (_, v) => v,
    default: () => '',
  }),

  /** Webview postMessage callback. */
  postMessage: Annotation<((msg: any) => void) | null>({
    reducer: (_, v) => v,
    default: () => null,
  }),

  /** Callback to request tool approval from the user (returns approval response). */
  requestApproval: Annotation<((callId: string, call: any, isStepMode: boolean) => Promise<any>) | null>({
    reducer: (_, v) => v,
    default: () => null,
  }),

  /** Callback to request a tool checklist approval from the user (returns approved tool calls). */
  requestChecklist: Annotation<((calls: any[]) => Promise<any[] | null>) | null>({
    reducer: (_, v) => v,
    default: () => null,
  }),

  /** Last assistant response text (for tool parsing). */
  lastAssistantResponse: Annotation<string>({
    reducer: (_, v) => v,
    default: () => '',
  }),

  /** Native structured tool calls returned by compatible providers. */
  lastAssistantToolCalls: Annotation<any[]>({
    reducer: (_, v) => v,
    default: () => [],
  }),

  /** Parsed tool calls from the last assistant response. */
  pendingToolCalls: Annotation<any[]>({
    reducer: (_, v) => v,
    default: () => [],
  }),

  /** Markdown summary of the current implementation plan, when generated. */
  implementationPlanSummary: Annotation<string>({
    reducer: (_, v) => v,
    default: () => '',
  }),

/** Flag set after compile has been run. */
   compileCompleted: Annotation<boolean>({
      reducer: (_, v) => v,
      default: () => false,
    }),

    /** Flag set after tests have been run. */
    testCompleted: Annotation<boolean>({
      reducer: (_, v) => v,
      default: () => false,
    }),

    /** Flag indicating we're waiting for LLM response after a self-heal fix attempt. */
    awaitingSelfHealResponse: Annotation<boolean>({
      reducer: (_, v) => v,
      default: () => false,
    }),

    /** Whether any file write/edit operations were performed in this run.
     *  Reducer uses OR-accumulation so a prior `true` is never overwritten by
     *  a later `false` from a failed edit. This is the fix for the verification
     *  loop silently skipping re-runs after a failed `edit_file`. */
    codeChangesMade: Annotation<boolean>({
      reducer: (existing, incoming) => {
        if (incoming === true) return true;
        return existing === true ? true : false;
      },
      default: () => false,
    }),

    /** Active subagent ID. */
    currentSubagentId: Annotation<string>({
      reducer: (_, v) => v,
      default: () => 'general-builder',
    }),

    /** Whether git workspace was clean before edits. */
    gitRollbackSafe: Annotation<boolean>({
      reducer: (_, v) => v,
      default: () => false,
    }),

    /** Whether git savepoint was checked. */
    gitSavepointChecked: Annotation<boolean>({
      reducer: (_, v) => v,
      default: () => false,
    }),

    /** Original file contents before agent edit/write operations. */
    fileBackups: Annotation<Record<string, string>>({
      reducer: (existing, incoming) => ({ ...existing, ...incoming }),
      default: () => ({}),
    }),

    /** Number of security audit iterations performed (budget of 2). */
    auditAttempt: Annotation<number>({
      reducer: (_, v) => v,
      default: () => 0,
    }),

    /** Last encountered compile error message. */
    lastCompileError: Annotation<string>({
      reducer: (_, v) => v,
      default: () => '',
    }),

    /** Fingerprint of the last compile error. */
    lastCompileErrorFingerprint: Annotation<string>({
      reducer: (_, v) => v,
      default: () => '',
    }),

    /** Last encountered tool parser error message. */
    lastParserError: Annotation<string>({
      reducer: (_, v) => v,
      default: () => '',
    }),

    /** Last encountered test failure message. */
    lastTestError: Annotation<string>({
      reducer: (_, v) => v,
      default: () => '',
    }),

    /** Maximum allowed security audits. */
    maxAudits: Annotation<number>({
      reducer: (_, v) => v,
      default: () => 2,
    }),

    /** Whether security audit completed successfully. */
    auditCompleted: Annotation<boolean>({
      reducer: (_, v) => v,
      default: () => false,
    }),

    /** Number of general review iterations performed (budget of 2). */
    reviewAttempt: Annotation<number>({
      reducer: (_, v) => v,
      default: () => 0,
    }),

    /** Maximum allowed general reviews. */
    maxReviews: Annotation<number>({
      reducer: (_, v) => v,
      default: () => 2,
    }),

    /** Whether general review completed successfully. */
    reviewCompleted: Annotation<boolean>({
      reducer: (_, v) => v,
      default: () => false,
    }),
});

// Type alias for convenience
export type AgentStateType = typeof AgentState.State;

function createCancellationTokenFromState(state: AgentStateType): { token: vscode.CancellationToken; cleanup: () => void } {
  const cts = new vscode.CancellationTokenSource();
  let interval: NodeJS.Timeout | undefined = undefined;
  if (state.checkCancellation) {
    interval = setInterval(() => {
      if (state.checkCancellation?.()) {
        cts.cancel();
        if (interval) clearInterval(interval);
      }
    }, 100);
  }
  return {
    token: cts.token,
    cleanup: () => {
      if (interval) clearInterval(interval);
    }
  };
}

async function callLLM(state: AgentStateType): Promise<Partial<AgentStateType>> {
  if (!state.isRunning || state.checkCancellation?.()) {
    return { isRunning: false, lastAssistantResponse: '', pendingToolCalls: [] };
  }

  const newLoopCount = state.loopCount + 1;
  AgentTrace.append({
    runId: state.runId || 'unknown',
    sessionId: state.sessionId,
    type: 'llm_start',
    timestamp: Date.now(),
    data: { loopCount: newLoopCount, messageCount: state.chatHistory.length },
  });
  if (newLoopCount > state.maxLoops) {
    state.onToken?.('\n\n⚠️ **Agent reached maximum loop count. Stopping.**\n');
    return {
      isRunning: false,
      loopCount: newLoopCount,
      lastAssistantResponse: '',
      pendingToolCalls: [],
    };
  }

  // Filter out any messages with empty content before sending to API.
  // Some providers (e.g. Gemini) reject history containing empty assistant turns.
  const cleanHistory = state.chatHistory.filter(
    (m) => m.content && m.content.trim() !== ''
  );

  try {
    const settings = AIService.getSettings();
    const coderModel = settings.coderModel || settings.chatModel;

    let dynamicSystemInstruction = state.systemInstruction;
    if (state.implementationPlanSummary) {
      dynamicSystemInstruction += `\n\n## Current Implementation Plan\n${state.implementationPlanSummary}`;
      dynamicSystemInstruction += `\n\nSTATUS: An implementation plan and task list have already been automatically created at \`.k-horizon/implementation_plan.md\` and \`.k-horizon/task.md\`. You MUST read \`.k-horizon/task.md\` first to see the tasks and proceed with executing them, updating the task list file as you complete them.`;
    } else {
      dynamicSystemInstruction += `\n\nSTATUS: No implementation plan was generated for this task because it is trivial or a direct/simple request. Do NOT look for, read, or write \`.k-horizon/implementation_plan.md\` or \`.k-horizon/task.md\`. Proceed directly to executing the user's request using the available tools.`;
    }

    // Inject loop awareness so the LLM self-regulates
    dynamicSystemInstruction += `\n\n## Execution Progress\nYou are on loop ${newLoopCount} of ${state.maxLoops}. Do NOT repeat tool calls you have already made. If a tool call returns an error or the same result as before, try a DIFFERENT approach or finalize your work.`;

    // Wire last error into the prompt as structured diagnostic context (Fix 7)
    if (state.lastCompileError) {
      dynamicSystemInstruction += `\n\n## Previous Compile Error\n\`\`\`\n${state.lastCompileError.slice(0, 2000)}\n\`\`\`\nThis error occurred during a previous compile attempt. Address it before making further changes. If you have already fixed it, run the compile command again to confirm.`;
    }
    if (state.lastTestError) {
      dynamicSystemInstruction += `\n\n## Previous Test Failure\n\`\`\`\n${state.lastTestError.slice(0, 2000)}\n\`\`\`\nThis test failure occurred during a previous test run. Address it before continuing.`;
    }
    if (state.lastParserError) {
      dynamicSystemInstruction += `\n\n## Previous Tool Parser Error\n\`\`\`\n${state.lastParserError.slice(0, 1000)}\n\`\`\`\nA tool-call parsing error occurred on the previous turn. Ensure your tool calls use valid JSON format.`;
    }

    const currentSub = SUBAGENTS.find(s => s.id === state.currentSubagentId);
    if (currentSub) {
      dynamicSystemInstruction += `\n\n## Active Subagent Mode: ${currentSub.label}\n${currentSub.systemPrompt}`;
    }

    dynamicSystemInstruction += `\n\n### Tool Selection Guidelines & Hierarchy:
You have tools to query the codebase and make edits. Follow this hierarchy. Only THREE file-modification tools exist — do not invent others:
0. **External MCP Tools (Highest Preference / Priority):**
   - Prioritize external MCP tools over built-in equivalents. E.g., use \`mcp__Filesystem__read_file\` instead of \`read_file\`, \`mcp__Filesystem__write_file\` instead of \`write_file\`, \`mcp__Filesystem__list_directory\` instead of \`list_dir\`, \`mcp__Filesystem__search_grep\` instead of \`grep_search\`, and \`mcp__Git__*\` tools instead of \`git_status\` / \`git_diff\`.
1. **File Modification (only three tools):**
   - \`read_file\` — Read a file's contents.
   - \`write_file\` — Create a new file or overwrite an entire file.
   - \`edit_file\` — Make a targeted search/replace edit in an existing file (preferred over \`write_file\` for surgical changes).
   - \`delete_file\` — Delete a file.
   - \`create_directory\` — Create directories.
   - \`copy_file\` / \`move_file\` — Copy or move files.
   - ⚠️ Do NOT use \`patch_file_lines\`, \`insert_file_lines\`, \`replace_in_files\`, \`run_speculative_patch\`, or \`run_speculative_workspace_patch\` — these have been removed. Use \`edit_file\` (search/replace) instead.
2. **Codebase Symbol & Reference Analysis (LSP Preference):**
   - To find definitions, callers, or trace where things are used: Use \`find_definitions\`, \`find_references\`, or \`trace_symbol_dependency\` (uses VS Code's LSP). Avoid reading random files or raw grep searching if you can trace symbols directly.
   - To check file metadata (size, lines, modified time) without loading contents: Use \`get_file_metadata\` (highly token-efficient!).
   - To query functions, classes, or types workspace-wide: Use \`search_workspace_symbols\`.
   - To check file-wide outlines: Use \`get_file_outline\`.
3. **Keyword & Directory Search:**
   - To find files matching a name pattern: Use \`find_files\`.
   - To search for text snippets or matches globally: Use \`grep_search\`.
   - To list directory contents: Use \`list_dir\`.
4. **Shell & Verification Commands:**
   - To run tests, compile builds, or execute shell checks: Use \`run_command\`. Pass the \`directory\` parameter if running in a subdirectory; NEVER use \`cd\` inside the command. ⚠️ Only allowed commands: \`npm\`, \`npx\`, \`node\`, \`git\`, \`tsc\`, \`webpack\`, \`vitest\`, \`jest\`, \`eslint\`, \`pwsh\`, \`powershell\`, \`cmd\`, and \`dir\`. Blocked: \`rm\`, \`del\`, \`rd\`, \`format\`, \`diskpart\`, \`reg\`, \`wget\`, \`curl\`, \`Invoke-WebRequest\`, and any network/destructive commands.
   - To view current git status or git diff: Use \`git_status\` or \`git_diff\`.
   - To inspect git changes for a single file: Use \`git_diff_file\`.
   - To verify that your edits succeeded and compile cleanly: Use \`verify_edit\`.`;

    const { token: cancelToken, cleanup } = createCancellationTokenFromState(state);
    let llmResult: any;
    try {
      let attempts = 0;
      const maxAttempts = 3;
      while (attempts < maxAttempts) {
        try {
          llmResult = await AIService.streamResponseDetailed(
            cleanHistory,
            dynamicSystemInstruction,
            (token) => {
              if (state.isRunning) {
                state.onToken?.(token);
              }
            },
            state.modelConfig?.modelId || coderModel || undefined,
            state.modelConfig?.provider || undefined,
            state.modelConfig?.temperature,
            cancelToken,
            { enableTools: true }
          );
          
          const textEmpty = !llmResult.text || llmResult.text.trim() === '';
          const reasoningEmpty = !llmResult.reasoning || llmResult.reasoning.trim() === '';
          const toolsEmpty = !llmResult.toolCalls || llmResult.toolCalls.length === 0;

          if (textEmpty && reasoningEmpty && toolsEmpty) {
            attempts++;
            if (attempts < maxAttempts) {
              state.onToken?.(`\n\n🔄 **Received empty response from LLM. Retrying (Attempt ${attempts + 1} of ${maxAttempts})...**\n`);
              await new Promise(r => setTimeout(r, 1000 * attempts));
              continue;
            }
          }
          break;
        } catch (err: any) {
          attempts++;
          if (attempts >= maxAttempts) {
            throw err;
          }
          state.onToken?.(`\n\n🔄 **LLM call failed: ${err.message}. Retrying (Attempt ${attempts + 1} of ${maxAttempts})...**\n`);
          await new Promise(r => setTimeout(r, 1000 * attempts));
        }
      }
    } finally {
      cleanup();
    }
    const fullResponseText = llmResult.text;
    const nativeToolCalls: ToolCall[] = llmResult.toolCalls;
    // Reasoning text is captured in llmResult.reasoning but deliberately NOT
    // stored in chatHistory or lastAssistantResponse. Storing it would waste
    // context tokens and pollute the conversation with model-internal monologue.
    // The webview handler may optionally render it in a collapsible panel.

    // Guard: if the LLM returns nothing, treat as a soft stop rather than storing
    // an empty assistant message which would break subsequent API calls.
    if ((!fullResponseText || fullResponseText.trim() === '') && nativeToolCalls.length === 0) {
      if (llmResult.reasoning && llmResult.reasoning.trim() !== '') {
        state.onToken?.('\n\n⚠️ **Warning:** LLM generated reasoning but no final response or tool call. Reprompting to complete the turn...\n');
        const repromptMsg: ChatMessage = {
          role: 'user',
          content: 'You outputted thinking/reasoning but no tool call or final text. Please output your next action using the JSON tool-call format now.',
          timestamp: Date.now()
        };
        return {
          chatHistory: [repromptMsg],
          loopCount: newLoopCount,
          lastAssistantResponse: '',
          lastAssistantToolCalls: [],
          pendingToolCalls: []
        };
      }

      state.onToken?.('\n\n⚠️ **Warning:** LLM returned a completely empty response. Stopping agent.\n');
      return {
        isRunning: false,
        loopCount: newLoopCount,
        lastAssistantResponse: '',
        lastAssistantToolCalls: [],
        pendingToolCalls: [],
      };
    }

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: fullResponseText || `[Native tool calls: ${nativeToolCalls.map(call => call.name).join(', ')}]`,
      timestamp: Date.now(),
    };

    AgentTrace.append({
      runId: state.runId || 'unknown',
      sessionId: state.sessionId,
      type: 'llm_finish',
      timestamp: Date.now(),
      data: {
        loopCount: newLoopCount,
        responseChars: fullResponseText.length,
        nativeToolCallCount: nativeToolCalls.length,
        responsePreview: fullResponseText.slice(0, 500),
      },
    });

    return {
      chatHistory: [assistantMessage],
      loopCount: newLoopCount,
      lastAssistantResponse: fullResponseText,
      lastAssistantToolCalls: nativeToolCalls,
      finalResponse: fullResponseText,
    };
  } catch (err: any) {
    state.onToken?.(`\n\n❌ **LLM Error:** ${err.message}\n`);
    return {
      isRunning: false,
      loopCount: newLoopCount,
      lastAssistantResponse: '',
      lastAssistantToolCalls: [],
      pendingToolCalls: [],
    };
  }
}

/**
 * Node: parseToolCalls
 * Parses XML tool calls from the last assistant response.
 */
async function parseToolCalls(state: AgentStateType): Promise<Partial<AgentStateType>> {
  if (!state.isRunning) {
    return { pendingToolCalls: [] };
  }

  const toolCalls = state.lastAssistantToolCalls && state.lastAssistantToolCalls.length > 0
    ? ToolManager.normalizeNativeToolCalls(state.lastAssistantToolCalls)
    : ToolManager.parseToolCalls(state.lastAssistantResponse || '');

  const lastParserError = ToolManager.lastParserError || '';

  AgentTrace.append({
    runId: state.runId || 'unknown',
    sessionId: state.sessionId,
    type: 'tool_calls_parsed',
    timestamp: Date.now(),
    data: {
      count: toolCalls.length,
      names: toolCalls.map(call => call.name),
      parserError: lastParserError || undefined,
      responsePreview: toolCalls.length === 0 ? (state.lastAssistantResponse || '').slice(0, 500) : undefined,
    },
  });

  const updates: Partial<AgentStateType> = { 
    pendingToolCalls: toolCalls,
    lastParserError
  };
  if (toolCalls.length > 0) {
    updates.consecutiveReprompts = 0;
    updates.continueTaskReprompts = 0;
  }
  return updates;
}

/**
 * Node: executeTools
 * Iterates through parsed tool calls, handles approval/step-debug, executes them,
 * and appends combined results as a user message to chatHistory.
 */
async function executeTools(state: AgentStateType): Promise<Partial<AgentStateType>> {
  if (!state.isRunning || state.checkCancellation?.() || !state.pendingToolCalls || state.pendingToolCalls.length === 0) {
    return { isRunning: !state.checkCancellation?.() };
  }

  // Backup files about to be modified
  const newBackups: Record<string, string> = {};
  for (const c of state.pendingToolCalls) {
    if (['edit_file', 'write_file', 'patch_file_lines', 'insert_file_lines'].includes(c.name)) {
      const filePath = c.arguments.file_path;
      if (filePath) {
        try {
          const abs = ToolManager.getAbsolutePath(filePath);
          if (abs && fs.existsSync(abs)) {
            if (state.fileBackups && !state.fileBackups[abs] && !newBackups[abs]) {
              newBackups[abs] = fs.readFileSync(abs, 'utf8');
            }
          }
        } catch (e) {
          // Ignore read/exists errors during backup check
        }
      }
    }
  }

  let gitRollbackSafe = state.gitRollbackSafe;
  let gitSavepointChecked = state.gitSavepointChecked;
  let lastCompileErrorFingerprint = state.lastCompileErrorFingerprint || '';

  if (!gitSavepointChecked) {
    gitSavepointChecked = true;
    try {
      const statusOutput = await ToolManager.execute('run_command', { command: 'git status --porcelain' });
      const failedFlagMatch = statusOutput.match(/\[FAILED:\s*(true|false)\]/);
      const failed = failedFlagMatch ? failedFlagMatch[1] === 'true' : statusOutput.includes('[COMMAND FAILED]');
      if (!failed) {
        const stdoutStart = statusOutput.indexOf('[STDOUT]\n');
        const stdoutText = stdoutStart !== -1 
          ? statusOutput.substring(stdoutStart + 9).split('[STDERR]')[0].trim() 
          : '';
        const lines = stdoutText.split('\n').filter(line => line.trim().length > 0 && !line.includes('[REMEDIATION HINT]') && !line.includes('[FAILED:'));
        gitRollbackSafe = lines.length === 0;
      }
    } catch (e) {
      gitRollbackSafe = false;
    }
  }

  let hasChecklistApproval = false;
  if (!state.autoApprove && state.requestChecklist && state.pendingToolCalls && state.pendingToolCalls.length > 0) {
    try {
      state.postMessage?.({
        type: 'showChecklistPrompt',
        toolCalls: state.pendingToolCalls
      });
      const approvedCalls = await state.requestChecklist(state.pendingToolCalls);
      if (!approvedCalls) {
        state.onToken?.('\n\n⚠️ **Checklist execution cancelled.**\n');
        return { isRunning: false, pendingToolCalls: [] };
      }
      state.pendingToolCalls = approvedCalls;
      hasChecklistApproval = true;
    } catch (e: any) {
      state.onToken?.(`\n\n❌ **Checklist error:** ${e.message}\n`);
      return { isRunning: false, pendingToolCalls: [] };
    }
  }

  let toolResultsCombined = '';
  let madeCodeChange = false;
  let nextSubagentId = state.currentSubagentId;

  // Multi-file safety: if there are multiple edit-like calls, attempt a speculative
  // workspace patch to validate the whole patch set before applying them to main branch.
  try {
    const fileModCalls = (state.pendingToolCalls || []).filter(c => ['edit_file', 'patch_file_lines'].includes(c.name));
    if (fileModCalls.length > 1) {
      const patches = [] as Array<{ file_path: string; target_content: string; replacement_content: string }>;
      for (const c of fileModCalls) {
        if (c.name === 'edit_file') {
          if (c.arguments.target_content === undefined || c.arguments.replacement_content === undefined) {
            patches.length = 0;
            break;
          }
          patches.push({ file_path: c.arguments.file_path, target_content: c.arguments.target_content, replacement_content: c.arguments.replacement_content });
        } else if (c.name === 'patch_file_lines') {
          // Convert patch_file_lines to a whole-file replacement for speculative run
          const fp = c.arguments.file_path;
          const start = parseInt(String(c.arguments.start_line || '1'), 10);
          const end = parseInt(String(c.arguments.end_line || '1'), 10);
          try {
            const abs = ToolManager.getAbsolutePath(fp);
            const content = (await ToolManager.execute('read_file', { file_path: fp })) as string;
            const lines = content.split(/\r?\n/);
            const originalSegment = lines.slice(start - 1, end).join('\n');
            const replacement = String(c.arguments.replacement_content || '');
            const newWhole = [...lines.slice(0, start - 1), replacement, ...lines.slice(end)].join('\n');
            patches.push({ file_path: fp, target_content: originalSegment, replacement_content: replacement });
          } catch (e) {
            // If reading fails, abort speculative path detection
            patches.length = 0;
            break;
          }
        }
      }

      if (patches.length > 0) {
        const workspaceRoot = state.workspaceRoot || getWorkspaceRoot();
        const cmds = workspaceRoot ? detectVerificationCommands(workspaceRoot) : { compileCommand: 'npm run compile', testCommand: null };
        const specRes = await ToolManager.execute('run_speculative_workspace_patch', { patches_json: JSON.stringify(patches), validation_command: cmds.compileCommand });
        if (typeof specRes === 'string' && specRes.startsWith('Success:')) {
          madeCodeChange = true;
          toolResultsCombined += `<tool_result name="run_speculative_workspace_patch">\n${specRes}\n</tool_result>\n`;
          // Short-circuit: we've merged the speculative branch into main; skip individual executions
          const toolResultMessage: ChatMessage = {
            role: 'user',
            content: toolResultsCombined,
            timestamp: Date.now(),
          };
          return {
            chatHistory: [toolResultMessage],
            pendingToolCalls: [],
            awaitingSelfHealResponse: false,
            codeChangesMade: madeCodeChange,
            currentSubagentId: nextSubagentId,
            gitRollbackSafe,
            gitSavepointChecked,
            fileBackups: newBackups,
          };
        } else {
          // Speculative validation failed — append message so model can see output and decide next steps.
          toolResultsCombined += `<tool_result name="run_speculative_workspace_patch">\n${specRes}\n</tool_result>\n`;
          // Continue to individual handling so the agent can attempt smaller fixes.
        }
      }
    }
  } catch (e) {
    // Non-fatal: continue with individual tool execution
  }

  for (const call of state.pendingToolCalls) {
    if (!state.isRunning || state.checkCancellation?.()) break;

    const callId = 'tc_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
    let proceed = true;
    let toolArgs = call.arguments;
    let result = '';

    if (state.stepDebug && state.requestApproval) {
      // Step debugger mode: wait for user input
      state.postMessage?.({
        type: 'toolCallStarted',
        toolCallId: callId,
        name: call.name,
        arguments: call.arguments,
        needsApproval: true,
        isStepMode: true,
      });

      const response = await state.requestApproval(callId, call, true);

      if (response.approved && response.arguments) {
        toolArgs = response.arguments;
        proceed = true;
      } else if (response.skipped) {
        proceed = false;
        result = `Success: Tool "${call.name}" was skipped by the user.`;
        state.postMessage?.({
          type: 'toolCallFinished',
          toolCallId: callId,
          name: call.name,
          result: 'Skipped by user.',
        });
      } else if (response.mocked) {
        proceed = false;
        result = response.mockValue || 'Success: Mocked output.';
        state.postMessage?.({
          type: 'toolCallFinished',
          toolCallId: callId,
          name: call.name,
          result: `Mocked: ${result}`,
        });
      } else {
        proceed = false;
        result = 'Error: Tool execution rejected by user.';
        state.postMessage?.({
          type: 'toolCallFinished',
          toolCallId: callId,
          name: call.name,
          error: 'Tool execution rejected by user.',
        });
      }
    } else {
      // Standard mode
      const needsManualApproval = !state.autoApprove && !hasChecklistApproval;

      state.postMessage?.({
        type: 'toolCallStarted',
        toolCallId: callId,
        name: call.name,
        arguments: call.arguments,
        needsApproval: needsManualApproval,
      });

      if (needsManualApproval && state.requestApproval) {
        const response = await state.requestApproval(callId, call, false);
        proceed = response.approved;

        if (!proceed) {
          result = 'Error: Tool execution rejected by user.';
          state.postMessage?.({
            type: 'toolCallFinished',
            toolCallId: callId,
            name: call.name,
            error: 'Tool execution rejected by user.',
          });
        }
      }
    }

    if (!state.isRunning) {
      state.postMessage?.({
        type: 'toolCallFinished',
        toolCallId: callId,
        name: call.name,
        error: 'Agent execution stopped by user.',
      });
      proceed = false;
    }

    if (proceed) {
      // Before executing any code-changing tools, keep an up-to-date dependency
      // graph so impact analysis can be used by the planner/coder. This helps
      // surface downstream files that may be affected by edits.
      try {
        const workspaceRoot = state.workspaceRoot || getWorkspaceRoot();
        if (workspaceRoot) {
          await ToolManager.execute('update_dependency_graph', {});
        }
      } catch (e) {
        // Non-fatal: proceed even if dependency graph update fails
      }
      let finalArgs = { ...toolArgs };

      // First check: does this tool even exist? Use the subagent's COMMON_TOOLS
      // list as the reference for known tools. MCP tools (mcp__*) and switch_subagent
      // are always allowed through.
      const isMCPTool = call.name.startsWith('mcp__');
      const isSpecialTool = call.name === 'switch_subagent';
      const toolAllowed = isSpecialTool || isToolAllowedForSubagent(state.currentSubagentId as SubagentId, call.name);

      if (!toolAllowed && !isMCPTool) {
        // Check if the tool is genuinely unknown (hallucinated) vs just blocked for this subagent
        const allToolNames = SUBAGENTS.find(s => s.id === 'general-builder')?.toolAllowList || [];
        const isKnownTool = allToolNames.some(t => {
          if (t === call.name) return true;
          if (t.endsWith('*')) return call.name.startsWith(t.slice(0, -1));
          return false;
        });
        if (!isKnownTool) {
          result = `Error: Unknown tool "${call.name}". This tool does not exist. You MUST use one of the available tools listed in your system prompt (e.g., read_file, write_file, edit_file, delete_file, run_command, list_dir, grep_search, find_files, etc.). Do NOT invent tool names.`;
        } else {
          result = `Error: Tool "${call.name}" is not allowed for subagent "${state.currentSubagentId}". Try switching to the "general-builder" subagent first using: {"name":"switch_subagent","arguments":{"subagent_id":"general-builder"}}`;
        }
        proceed = false;
      }

      if (proceed && call.name === 'switch_subagent') {
        const targetId = finalArgs.subagent_id;
        if (SUBAGENTS.some(s => s.id === targetId)) {
          nextSubagentId = targetId;
        }
      }

      if (proceed) {
        AgentTrace.append({
          runId: state.runId || 'unknown',
          sessionId: state.sessionId,
          type: 'tool_start',
          timestamp: Date.now(),
          data: { name: call.name, arguments: finalArgs },
        });
        result = await ToolManager.execute(call.name, finalArgs);
      }
      // For run_command results, keep the structured summary header (EXIT_CODE, NPM_ERR_CODE,
      // REMEDIATION HINT) AND the diagnostic middle so the side panel preview is still
      // useful — head/tail truncation would hide the actual npm ERR! block.
      let resultPreview: string;
      if (call.name === 'run_command' && result.length > 1500) {
        const headerEnd = result.indexOf('\n\n');
        const header = headerEnd > 0 ? result.substring(0, headerEnd) : '';
        const body = headerEnd > 0 ? result.substring(headerEnd + 2) : '';
        const errMatch = body.match(/((?:npm ERR!|error TS\d+|ERROR in|\[tsl\] ERROR|SyntaxError|AssertionError|Error:|FAIL| ❯ | ✗ )[^\n]*\n(?:[^\n]*\n){0,3})/);
        const snippet = errMatch ? errMatch[0] : body.substring(0, 400);
        resultPreview = (header + '\n\n' + snippet + '\n... (further output elided)').substring(0, 1200);
      } else {
        resultPreview = result.length > 1000 ? result.substring(0, 1000) + '\n... (truncated)' : result;
      }

      AgentTrace.append({
        runId: state.runId || 'unknown',
        sessionId: state.sessionId,
        type: result.startsWith('Error') ? 'tool_error' : 'tool_finish',
        timestamp: Date.now(),
        data: { name: call.name, resultPreview },
      });

      // Track if code changes were made
      if ((call.name === 'write_file' || call.name === 'edit_file' || call.name === 'delete_file') && result.startsWith('Success:')) {
        madeCodeChange = true;

        // Implicit verify_edit: after every successful write_file/edit_file, read the file
        // back from disk and grab diagnostics. This catches the common failure mode where
        // the edit succeeded but introduced a new TypeScript error (off-by-one line shift,
        // accidental overwrite of adjacent code, mismatched braces, etc.). The diagnostics
        // are appended to the tool result so the next LLM turn sees them.
        const filePath = finalArgs.file_path || '';
        const isCodeOrConfig = filePath && /\.(ts|tsx|js|jsx|json)$/i.test(filePath);
        if ((call.name === 'write_file' || call.name === 'edit_file') && filePath && isCodeOrConfig) {
          try {
            const verifyResult = await ToolManager.execute('verify_edit', { file_path: filePath });
            const verifyDiagnostics = verifyResult.split('\nDiagnostics:\n')[1] || '';
            const hasErrors = /\[Error\]/.test(verifyDiagnostics);
            const verifySuffix = hasErrors
              ? `\n\n[AUTO-VERIFY] ⚠️ New diagnostics detected after this edit:\n${verifyDiagnostics}`
              : `\n\n[AUTO-VERIFY] ✅ No new diagnostics detected.`;
            result = result + verifySuffix;
            resultPreview = resultPreview + verifySuffix;
          } catch (e: any) {
            result = result + `\n\n[AUTO-VERIFY] verify_edit failed: ${e.message}`;
          }

          // Run a targeted verification (compile) after each successful file edit/write
          try {
            const workspaceRoot = state.workspaceRoot || getWorkspaceRoot();
            if (workspaceRoot) {
              const cmds = detectVerificationCommands(workspaceRoot);
              if (cmds.compileCommand) {
                const compileOut = await ToolManager.execute('run_command', { command: cmds.compileCommand });
                const failedFlagMatch = compileOut.match(/\[FAILED:\s*(true|false)\]/);
                const failed = failedFlagMatch ? failedFlagMatch[1] === 'true' : (compileOut.includes('[COMMAND FAILED]') || compileOut.includes('[COMMAND TIMEOUT]') || compileOut.trim().startsWith('Error:'));
                let compileSuffix = '';
                if (failed) {
                  const compileFingerprint = getCompileErrorFingerprint(compileOut);
                  if (state.lastCompileErrorFingerprint && compileFingerprint === state.lastCompileErrorFingerprint) {
                    compileSuffix = `\n\n[AUTO-COMPILE] ⚠️ Compile failed with the same error as last time. (Diagnostic output omitted to reduce context bloat).`;
                  } else {
                    lastCompileErrorFingerprint = compileFingerprint;
                    const hasMissingLocalImports = 
                      /error TS2307: Cannot find module ['"]\.[^'"]+['"]/i.test(compileOut) ||
                      /cannot find module ['"]\.[^'"]+['"]/i.test(compileOut) ||
                      /can't resolve ['"]\.[^'"]+['"]/i.test(compileOut) ||
                      /ModuleNotFoundError: No module named ['"]\.[^'"]+['"]/i.test(compileOut);
                    let hint = '';
                    if (hasMissingLocalImports) {
                      hint = `\n\n⚠️ **IMPORTANT**: This compile failure is likely because the imported local files/components (relative imports starting with ".") do not exist in the workspace yet. Do NOT delete, rollback, or undo your changes. Instead, simply proceed to create the missing files/components in your next step.`;
                    }
                    compileSuffix = `\n\n[AUTO-COMPILE] ⚠️ Compile failed after this edit:\n${compileOut}${hint}`;
                  }
                } else {
                  compileSuffix = `\n\n[AUTO-COMPILE] ✅ Compile succeeded after this edit.`;
                  lastCompileErrorFingerprint = '';
                }
                result = result + compileSuffix;
                resultPreview = resultPreview + compileSuffix;
              }
            }
          } catch (e: any) {
            result = result + `\n\n[AUTO-COMPILE] failed: ${e.message}`;
            resultPreview = resultPreview + `\n\n[AUTO-COMPILE] failed: ${e.message}`;
          }
        }
      }

      state.postMessage?.({
        type: 'toolCallFinished',
        toolCallId: callId,
        name: call.name,
        result: resultPreview,
      });
    } else if (!state.stepDebug) {
      result = state.isRunning
        ? 'Error: Tool execution rejected by user.'
        : 'Error: Agent execution stopped by user.';
    }

    let resultForModel = result;
    const isEditOrFileTool = ['edit_file', 'patch_file_lines', 'write_file', 'verify_edit'].includes(call.name);
    const maxResultLen = isEditOrFileTool ? 3000 : 16000;
    if (result.length > maxResultLen) {
      if (call.name === 'run_command') {
        // For npm-style outputs we keep the structured summary header intact
        // (EXIT_CODE, NPM_ERR_CODE, REMEDIATION HINT) and trim the verbose
        // STDOUT/STDERR blocks around the npm ERR lines, which is where the
        // real diagnostic information lives.
        const headerEnd = result.indexOf('\n\n');
        const header = headerEnd > 0 ? result.substring(0, headerEnd) + '\n\n' : '';
        const body = headerEnd > 0 ? result.substring(headerEnd + 2) : result;

        // Preserve any npm ERR! lines plus 200 chars of context on each side
        const errMatches: Array<{ start: number; end: number }> = [];
        const errRegex = /(?:npm ERR!|error TS\d+|ERROR in|\[tsl\] ERROR|SyntaxError|AssertionError|Error:|FAIL| ❯ | ✗ )[^\n]*/g;
        let m: RegExpExecArray | null;
        while ((m = errRegex.exec(body)) !== null) {
          errMatches.push({
            start: Math.max(0, m.index - 200),
            end: Math.min(body.length, m.index + m[0].length + 200),
          });
        }
        // De-overlap
        const merged: Array<{ start: number; end: number }> = [];
        for (const w of errMatches.sort((a, b) => a.start - b.start)) {
          const last = merged[merged.length - 1];
          if (last && w.start <= last.end) {
            last.end = Math.max(last.end, w.end);
          } else {
            merged.push({ ...w });
          }
        }
        const middle = merged.length > 0
          ? merged.map(w => body.substring(w.start, w.end)).join('\n... [DIAGNOSTIC ELIDED] ...\n')
          : body.substring(Math.max(0, body.length / 2 - 3000), Math.min(body.length, body.length / 2 + 3000));

        const truncatedBodyLen = body.length - middle.length;
        resultForModel =
          header +
          middle +
          `\n\n... [TRUNCATED ${truncatedBodyLen} NON-DIAGNOSTIC CHARACTERS FROM ${body.length}-CHAR BODY; HEAD/TAIL omitted to preserve npm ERR! lines] ...\n`;
      } else {
        const keepLen = Math.floor(maxResultLen / 2);
        resultForModel = result.substring(0, keepLen) +
          `\n\n... [TRUNCATED ${result.length - maxResultLen} CHARACTERS FOR BREVITY] ...\n\n` +
          result.substring(result.length - keepLen);
      }
    }

    toolResultsCombined += `<tool_result name="${call.name}">\n${resultForModel}\n</tool_result>\n`;
  }

  if (!state.isRunning) {
    return { isRunning: false };
  }

// Add tool results as a user turn to chatHistory
   const toolResultMessage: ChatMessage = {
     role: 'user',
     content: toolResultsCombined,
     timestamp: Date.now(),
   };

    return {
      chatHistory: [toolResultMessage],
      pendingToolCalls: [],
      awaitingSelfHealResponse: false,
      codeChangesMade: madeCodeChange,
      currentSubagentId: nextSubagentId,
      gitRollbackSafe,
      gitSavepointChecked,
      fileBackups: newBackups,
      lastCompileErrorFingerprint,
    };
}

/**
 * Node: runCompile
 * Runs the detected compile command and reports results.
 */
async function runCompile(state: AgentStateType): Promise<Partial<AgentStateType>> {
  if (!state.isRunning || state.checkCancellation?.()) {
    return { isRunning: false, compileCompleted: true };
  }

  state.onToken?.(`\n\n⚙️ **Auto-Compile Triggered:** Verifying build using \`${state.compileCommand}\`...\n`);

  AgentTrace.append({
    runId: state.runId || 'unknown',
    sessionId: state.sessionId,
    type: 'verify_compile_start',
    timestamp: Date.now(),
    data: { command: state.compileCommand },
  });
  const buildOutput = await ToolManager.execute('run_command', { command: state.compileCommand });

  // Use the structured header written by runCommand instead of substring
  // matching on "fail"/"error" (which fires on benign npm deprecation notices
  // and would also miss real failures that don't contain those words).
  const exitMatch = buildOutput.match(/\[EXIT_CODE:\s*([^\]]+)\]/);
  const failedFlagMatch = buildOutput.match(/\[FAILED:\s*(true|false)\]/);
  const npmCodeMatch = buildOutput.match(/\[NPM_ERR_CODE:\s*([^\]]+)\]/);
  const exitCodeStr = exitMatch ? exitMatch[1].trim() : '';
  const exitCodeNum = exitCodeStr === 'null' ? null : parseInt(exitCodeStr, 10);
  const failed = failedFlagMatch ? failedFlagMatch[1] === 'true' : (buildOutput.includes('[COMMAND FAILED]') || buildOutput.includes('[COMMAND TIMEOUT]') || buildOutput.trim().startsWith('Error:'));

  if (failed) {
    const attemptNum = state.compileHealAttempts + 1;

    const hasMissingLocalImports = 
      /error TS2307: Cannot find module ['"]\.[^'"]+['"]/i.test(buildOutput) ||
      /cannot find module ['"]\.[^'"]+['"]/i.test(buildOutput) ||
      /can't resolve ['"]\.[^'"]+['"]/i.test(buildOutput) ||
      /ModuleNotFoundError: No module named ['"]\.[^'"]+['"]/i.test(buildOutput);

    if (hasMissingLocalImports) {
      state.onToken?.('\n\nℹ️ **Missing local files detected. Bypassing compilation self-healing so you can proceed to create the missing files.**\n');
      return {
        compileCompleted: true,
        awaitingSelfHealResponse: false,
        consecutiveTextOnlyHealResponses: 0,
        lastCompileError: '',
        finalResponse: '\n\nℹ️ **Compilation Bypassed:** Missing local files/imports detected. Proceeding to let you create the missing files.',
      };
    }

    if (attemptNum > 3) {
      state.onToken?.('\n\n❌ **Auto-Compile failed to resolve errors after 3 attempts.**\n');
      
      if (state.gitRollbackSafe) {
        state.onToken?.('⚠️ **Git-Backed Rollback:** Reverting workspace changes to last clean state...\n');
        await ToolManager.execute('run_command', { command: 'git reset --hard HEAD && git clean -fd' });
      } else if (state.fileBackups && Object.keys(state.fileBackups).length > 0) {
        state.onToken?.('⚠️ **Workspace Rollback:** Reverting modified files to pre-edit state...\n');
        for (const [fileAbs, originalContent] of Object.entries(state.fileBackups)) {
          try {
            fs.writeFileSync(fileAbs, originalContent, 'utf8');
          } catch (restoreErr) {
            console.error(`Failed to restore backup for ${fileAbs}:`, restoreErr);
          }
        }
      }
      return { compileCompleted: true, compileHealAttempts: attemptNum, awaitingSelfHealResponse: false, consecutiveTextOnlyHealResponses: 0 };
    }

    const categoryHint = (buildOutput.match(/\[CATEGORY:\s*([^\]]+)\]/) || [, ''])[1];
    const remediationHint = (buildOutput.match(/\[REMEDIATION HINT\]\s*([^\n]+)/) || [, ''])[1];
    const suspectedFile = (buildOutput.match(/\[SUSPECTED_FILE:\s*([^\]]+)\]/) || [, ''])[1];
    const headerSummary = [
      `Exit code: ${exitCodeNum === null ? 'unknown (likely signal/timeout)' : exitCodeNum}`,
      npmCodeMatch ? `npm error code: ${npmCodeMatch[1]}` : null,
      categoryHint ? `category: ${categoryHint}` : null,
      suspectedFile ? `suspected file: ${suspectedFile}` : null,
      remediationHint ? `remediation: ${remediationHint}` : null,
    ].filter(Boolean).join('\n');

    state.onToken?.(`\n⚠️ Build failed (${attemptNum}/3). Retrying...\n`);
    if (headerSummary) {
      state.onToken?.(`\n${headerSummary}\n`);
    }

    // Get live diagnostics
    const liveDiagnostics = await ToolManager.execute('get_diagnostics', {});

    // Gather richer failure diagnostics (re-run, git-diff, file preview) to help reproduce/isolate
    let richerDiagnostics = '';
    try {
      richerDiagnostics = await ToolManager.execute('gather_failure_diagnostics', { command: state.compileCommand, file_path: suspectedFile });
    } catch (e: any) {
      richerDiagnostics = `Error gathering richer diagnostics: ${e.message || e}`;
    }

    let missingLocalHint = '';
    if (hasMissingLocalImports) {
      missingLocalHint = `\n\n⚠️ **IMPORTANT**: This compile failure is likely because the imported local files/components (e.g. relative imports starting with ".") do not exist in the workspace yet. Do NOT delete or undo your changes to the import statements. Instead, simply proceed to create the missing files/components (e.g. create the components) in this turn.`;
    }

    const fixPrompt = `The project build failed. ${missingLocalHint}

Failure summary (parsed from the command output, not guessed):
\`\`\`
${headerSummary || '(no structured summary available)'}
\`\`\`

Full command output (with the diagnostic middle preserved, head/tail elided):
\`\`\`
${buildOutput}
\`\`\`

Active VS Code Editor Diagnostics:
\`\`\`
${liveDiagnostics}
\`\`\`

Instructions:
1. Read the FAILURE SUMMARY first. The npm error code, category, and remediation hint above are derived from the actual \`npm ERR!\` lines, not substring guesses — trust them.
2. If the category is \`eresolve\` / \`epeer\` / \`eacces\` / \`enoent\` / \`missing-script\` / \`missing-package-json\` / \`command-not-found\` / \`missing-dependency\`, do NOT edit unrelated code. Address the package.json / install / path issue described in the remediation hint.
3. If the category is \`compile\`, open the file at the line/column reported by tsc and fix the type or import error.
4. If the compile error is about a missing import or module export, do NOT guess the exports. You MUST read the imported file/module first (using the read_file tool) to see what it actually exports and use the correct export name and type.
5. If the compile error is an implicit 'any' error, add explicit TypeScript types to the reported parameters/variables.
6. If the compile error is an unused variable or import warning/error, remove the unused declaration.
7. If the compile error is a type mismatch for animation/easing arrays, cast the array as const (e.g., [0.6, 0.05, -0.01, 0.9] as const).
8. If the category is \`elifecycle\`, the ELIFECYCLE line is just a wrapper — read the underlying error message above it for the actual root cause.
9. Only edit files inside the workspace. Do not invent fictional npm scripts.
10. After making changes, output the actual JSON tool call — {"name": "edit_file", "arguments": {...}} (or an array of such calls) — so the agent parser can execute it. Do not write a markdown code block; that will be ignored.`;

    let historicalFixesPrompt = '';
    if (state.workspaceRoot) {
      try {
        const { ErrorFixMemoryManager } = await import('./learning-manager');
        historicalFixesPrompt = await ErrorFixMemoryManager.findMatchingFixesAsPrompt(state.workspaceRoot, buildOutput);
      } catch (e) {
        console.error('Failed to load historical fixes:', e);
      }
    }

    const fixPromptWithDiagnostics = fixPrompt + '\n\nRicher Failure Diagnostics (re-run, git-diff, file preview):\n\n```\n' + richerDiagnostics + '\n```' + historicalFixesPrompt;

    const fixMessage: ChatMessage = {
      role: 'user',
      content: fixPromptWithDiagnostics,
      timestamp: Date.now(),
    };

    return {
      chatHistory: [fixMessage],
      compileHealAttempts: attemptNum,
      testHealAttempts: state.testHealAttempts, // preserve test budget
      compileCompleted: false,
      awaitingSelfHealResponse: true,
      consecutiveTextOnlyHealResponses: 0,
      lastCompileError: buildOutput
    };
  } else {
    // Compile succeeded!
    if (state.compileHealAttempts > 0 && state.lastCompileError && state.workspaceRoot && state.fileBackups) {
      import('./learning-manager').then(async ({ ErrorFixMemoryManager }) => {
        const diffStr = ErrorFixMemoryManager.generateDiffString(state.fileBackups, state.workspaceRoot);
        const modifiedFiles = Object.keys(state.fileBackups).map(f => path.relative(state.workspaceRoot, f).replace(/\\/g, '/'));
        if (diffStr) {
          await ErrorFixMemoryManager.saveFix(state.workspaceRoot, state.lastCompileError, 'compile', modifiedFiles, diffStr);
        }
      }).catch(() => {});
    }

    state.onToken?.('\n\n✨ **Build verified successfully! Project compiled with zero errors.**\n');
    return {
      compileCompleted: true,
      awaitingSelfHealResponse: false,
      consecutiveTextOnlyHealResponses: 0,
      lastCompileError: '',
      finalResponse: '\n\n✨ **Build Verified:** Project compiled successfully.',
    };
  }
}

/**
 * Node: runTest
 * Runs the detected test command and reports results.
 */
async function runTest(state: AgentStateType): Promise<Partial<AgentStateType>> {
  if (!state.isRunning || state.checkCancellation?.()) {
    return { isRunning: false, testCompleted: true };
  }

  state.onToken?.(`\n\n🧪 **Auto-Test Triggered:** Running unit tests using \`${state.testCommand}\`...\n`);

  AgentTrace.append({
    runId: state.runId || 'unknown',
    sessionId: state.sessionId,
    type: 'verify_test_start',
    timestamp: Date.now(),
    data: { command: state.testCommand },
  });
  const testOutput = await ToolManager.execute('run_command', { command: state.testCommand });

  // Use the structured header written by runCommand instead of substring
  // matching. The previous code matched the literal word "fail" or "error"
  // anywhere in the log, which fired on harmless output like
  // "0 errors" or "npm WARN deprecated" and would not match
  // ELIFECYCLE / ERESOLVE failures that don't contain those words.
  const exitMatch = testOutput.match(/\[EXIT_CODE:\s*([^\]]+)\]/);
  const failedFlagMatch = testOutput.match(/\[FAILED:\s*(true|false)\]/);
  const npmCodeMatch = testOutput.match(/\[NPM_ERR_CODE:\s*([^\]]+)\]/);
  const exitCodeStr = exitMatch ? exitMatch[1].trim() : '';
  const exitCodeNum = exitCodeStr === 'null' ? null : parseInt(exitCodeStr, 10);
  const failed = failedFlagMatch ? failedFlagMatch[1] === 'true' : (testOutput.includes('[COMMAND FAILED]') || testOutput.includes('[COMMAND TIMEOUT]') || testOutput.trim().startsWith('Error:'));

  if (failed) {
    const attemptNum = state.testHealAttempts + 1;

    if (attemptNum > 3) {
      state.onToken?.('\n❌ **Auto-Test Failed:** Could not resolve test failures after 3 attempts.\n');
      
      const hasMissingLocalImports = 
        /error TS2307: Cannot find module ['"]\.[^'"]+['"]/i.test(testOutput) ||
        /cannot find module ['"]\.[^'"]+['"]/i.test(testOutput) ||
        /can't resolve ['"]\.[^'"]+['"]/i.test(testOutput) ||
        /ModuleNotFoundError: No module named ['"]\.[^'"]+['"]/i.test(testOutput);
        
      if (hasMissingLocalImports) {
        state.onToken?.('ℹ️ **Missing local files detected. Skipping workspace rollback to let you create the missing files.**\n');
      } else {
        if (state.gitRollbackSafe) {
          state.onToken?.('⚠️ **Git-Backed Rollback:** Reverting workspace changes to last clean state...\n');
          await ToolManager.execute('run_command', { command: 'git reset --hard HEAD && git clean -fd' });
        } else if (state.fileBackups && Object.keys(state.fileBackups).length > 0) {
          state.onToken?.('⚠️ **Workspace Rollback:** Reverting modified files to pre-edit state...\n');
          for (const [fileAbs, originalContent] of Object.entries(state.fileBackups)) {
            try {
              fs.writeFileSync(fileAbs, originalContent, 'utf8');
            } catch (restoreErr) {
              console.error(`Failed to restore backup for ${fileAbs}:`, restoreErr);
            }
          }
        }
      }
      return { testCompleted: true, testHealAttempts: attemptNum, awaitingSelfHealResponse: false, consecutiveTextOnlyHealResponses: 0 };
    }

    const categoryHint = (testOutput.match(/\[CATEGORY:\s*([^\]]+)\]/) || [, ''])[1];
    const remediationHint = (testOutput.match(/\[REMEDIATION HINT\]\s*([^\n]+)/) || [, ''])[1];
    const suspectedFile = (testOutput.match(/\[SUSPECTED_FILE:\s*([^\]]+)\]/) || [, ''])[1];
    const headerSummary = [
      `Exit code: ${exitCodeNum === null ? 'unknown (likely signal/timeout)' : exitCodeNum}`,
      npmCodeMatch ? `npm error code: ${npmCodeMatch[1]}` : null,
      categoryHint ? `category: ${categoryHint}` : null,
      suspectedFile ? `suspected file: ${suspectedFile}` : null,
      remediationHint ? `remediation: ${remediationHint}` : null,
    ].filter(Boolean).join('\n');

    state.onToken?.(`\n⚠️ Tests failed (${attemptNum}/3). Retrying...\n`);
    if (headerSummary) {
      state.onToken?.(`\n${headerSummary}\n`);
    }

    // Gather richer failure diagnostics to help reproduce/isolate test failures
    let richerTestDiagnostics = '';
    try {
      richerTestDiagnostics = await ToolManager.execute('gather_failure_diagnostics', { command: state.testCommand, file_path: suspectedFile });
    } catch (e: any) {
      richerTestDiagnostics = `Error gathering richer diagnostics: ${e.message || e}`;
    }

    let missingLocalHint = '';
    const hasMissingLocalImports = 
      /error TS2307: Cannot find module ['"]\.[^'"]+['"]/i.test(testOutput) ||
      /cannot find module ['"]\.[^'"]+['"]/i.test(testOutput) ||
      /can't resolve ['"]\.[^'"]+['"]/i.test(testOutput) ||
      /ModuleNotFoundError: No module named ['"]\.[^'"]+['"]/i.test(testOutput);
    
    if (hasMissingLocalImports) {
      missingLocalHint = `\n\n⚠️ **IMPORTANT**: This test failure is likely because the imported local files/components (e.g. relative imports starting with ".") do not exist in the workspace yet. Do NOT delete or undo your changes to the import statements. Instead, simply proceed to create the missing files/components (e.g. create the components) in this turn.`;
    }

    const testFixPrompt = `The project tests failed. ${missingLocalHint}

Failure summary (parsed from the command output, not guessed):
\`\`\`
${headerSummary || '(no structured summary available)'}
\`\`\`

Full command output (with the diagnostic middle preserved):
\`\`\`
${testOutput}
\`\`\`

Instructions:
1. Read the FAILURE SUMMARY first.
2. If the category is \`compile\` or \`eresolve\` / \`epeer\` / \`missing-package-json\` / \`missing-dependency\`, fix the build/dependency problem first — tests can't pass against a project that doesn't compile.
3. If the compile error is about a missing import or module export, do NOT guess the exports. You MUST read the imported file/module first (using the read_file tool) to see what it actually exports and use the correct export name and type.
4. If the compile error is an implicit 'any' error, add explicit TypeScript types to the reported parameters/variables.
5. If the compile error is an unused variable or import warning/error, remove the unused declaration.
6. If the compile error is a type mismatch for animation/easing arrays, cast the array as const (e.g., [0.6, 0.05, -0.01, 0.9] as const).
7. Otherwise look at the assertion failure: which file, which test, expected vs actual. Fix the code under test (not the test expectations) unless the test expectation itself is wrong.
8. Output the actual JSON tool call — {"name": "edit_file", "arguments": {...}} (or an array of such calls) — so the agent parser can execute it. Do not write a markdown code block; that will be ignored.`;

    let historicalFixesPrompt = '';
    if (state.workspaceRoot) {
      try {
        const { ErrorFixMemoryManager } = await import('./learning-manager');
        historicalFixesPrompt = await ErrorFixMemoryManager.findMatchingFixesAsPrompt(state.workspaceRoot, testOutput);
      } catch (e) {
        console.error('Failed to load historical fixes:', e);
      }
    }

    const testFixPromptWithDiagnostics = testFixPrompt + '\n\nRicher Failure Diagnostics (re-run, git-diff, file preview):\n\n```\n' + richerTestDiagnostics + '\n```' + historicalFixesPrompt;

    const fixMessage: ChatMessage = {
      role: 'user',
      content: testFixPromptWithDiagnostics,
      timestamp: Date.now(),
    };

    return {
      chatHistory: [fixMessage],
      compileHealAttempts: state.compileHealAttempts, // preserve compile budget
      testHealAttempts: attemptNum,
      testCompleted: false,
      awaitingSelfHealResponse: true,
      consecutiveTextOnlyHealResponses: 0,
      lastTestError: testOutput
    };
  } else {
    // Test succeeded!
    if (state.testHealAttempts > 0 && state.lastTestError && state.workspaceRoot && state.fileBackups) {
      import('./learning-manager').then(async ({ ErrorFixMemoryManager }) => {
        const diffStr = ErrorFixMemoryManager.generateDiffString(state.fileBackups, state.workspaceRoot);
        const modifiedFiles = Object.keys(state.fileBackups).map(f => path.relative(state.workspaceRoot, f).replace(/\\/g, '/'));
        if (diffStr) {
          await ErrorFixMemoryManager.saveFix(state.workspaceRoot, state.lastTestError, 'test-failure', modifiedFiles, diffStr);
        }
      }).catch(() => {});
    }

    state.onToken?.('\n✨ **Auto-Test Passed:** All unit tests compiled and passed successfully!\n');
    return {
      testCompleted: true,
      awaitingSelfHealResponse: false,
      consecutiveTextOnlyHealResponses: 0,
      finalResponse: '\n\n✨ **Auto-Test Verified:** All unit tests passed successfully.',
      lastTestError: ''
    };
  }
}

/**
 * Node: runSecurityAudit
 * Audits code changes using the security-reviewer subagent.
 */
async function runSecurityAudit(state: AgentStateType): Promise<Partial<AgentStateType>> {
  if (!state.isRunning || state.checkCancellation?.()) {
    return { isRunning: false, auditCompleted: true };
  }

  // Skip audit if no changes were made or if we've reached the maximum audit attempts
  if (!state.codeChangesMade || state.auditAttempt >= state.maxAudits || state.currentSubagentId === 'security-reviewer') {
    return { auditCompleted: true };
  }

  state.onToken?.('\n\n🛡️ **Security Audit Triggered:** Auditing changes using the security-reviewer subagent...\n');

  AgentTrace.append({
    runId: state.runId || 'unknown',
    sessionId: state.sessionId,
    type: 'security_audit_start',
    timestamp: Date.now(),
    data: { attempt: state.auditAttempt + 1 },
  });

  const diffOutput = await ToolManager.execute('git_diff', {});
  if (!diffOutput || diffOutput.trim() === '' || diffOutput.startsWith('Error')) {
    state.onToken?.('✨ **Security Audit Skipped:** No uncommitted changes detected to audit.\n');
    return { auditCompleted: true };
  }

  const attemptNum = state.auditAttempt + 1;

  const auditSystemPrompt = `You are a security reviewer subagent. Audit the given code diff for vulnerabilities (OWASP, injections, secrets leak, SSRF, authentication/authorization issues) and logical bugs.
If you find issues, output them clearly citing file and line numbers, and explain the fix.
If the diff is clean and has no security risks, respond with the exact word: NO_VULNERABILITIES_FOUND.`;

  const auditPrompt = `Please audit the following codebase diff:
\`\`\`diff
${diffOutput}
\`\`\`
`;

  try {
    const settings = AIService.getSettings();
    const coderModel = settings.coderModel || settings.chatModel;

    const { token: cancelToken, cleanup } = createCancellationTokenFromState(state);
    let llmResult;
    try {
      llmResult = await AIService.streamResponseDetailed(
        [{ role: 'user', content: auditPrompt, timestamp: Date.now() }],
        auditSystemPrompt,
        (token) => {},
        state.modelConfig?.modelId || coderModel || undefined,
        state.modelConfig?.provider || undefined,
        state.modelConfig?.temperature,
        cancelToken,
        { enableTools: false }
      );
    } finally {
      cleanup();
    }

    const reviewerOutput = llmResult.text;
    const cleanOutput = reviewerOutput.trim();

    if (cleanOutput.includes('NO_VULNERABILITIES_FOUND')) {
      state.onToken?.('\n✨ **Security Audit Passed:** No critical security vulnerabilities found!\n');
      return {
        auditCompleted: true,
        auditAttempt: attemptNum,
      };
    } else {
      state.onToken?.(`\n⚠️ **Security Audit Found Potential Issues (Attempt ${attemptNum}/${state.maxAudits}):**\n${reviewerOutput}\n`);
      
      const fixMessage: ChatMessage = {
        role: 'user',
        content: `The security-reviewer subagent audited the git diff and identified the following issues:\n\n${reviewerOutput}\n\nYou MUST fix these issues. Output the JSON tool call(s) to apply the fixes.`,
        timestamp: Date.now(),
      };

      return {
        chatHistory: [fixMessage],
        auditCompleted: false,
        auditAttempt: attemptNum,
        compileCompleted: false,
        testCompleted: false,
      };
    }
  } catch (err: any) {
    state.onToken?.(`\n\n❌ **Security Audit Error:** ${err.message}\n`);
    return {
      auditCompleted: true,
      auditAttempt: attemptNum,
    };
  }
}

/**
 * Node: runGeneralReview
 * Non-security review pass focusing on correctness, maintainability, API design,
 * and style. Runs on the current git diff and asks the model to flag issues and
 * output either NO_REVIEW_ISSUES_FOUND or a list of fixes. If issues are found,
 * the agent is prompted to produce JSON tool calls to apply fixes.
 */
async function runGeneralReview(state: AgentStateType): Promise<Partial<AgentStateType>> {
  if (!state.isRunning || state.checkCancellation?.()) {
    return { isRunning: false, reviewCompleted: true };
  }

  // Skip review if no changes were made or if we've reached max reviews
  if (!state.codeChangesMade || state.reviewAttempt >= state.maxReviews || state.currentSubagentId === 'security-reviewer') {
    return { reviewCompleted: true };
  }

  state.onToken?.('\n\n🧐 **General Review Triggered:** Running a non-security review pass on the code changes...\n');

  AgentTrace.append({
    runId: state.runId || 'unknown',
    sessionId: state.sessionId,
    type: 'general_review_start',
    timestamp: Date.now(),
    data: { attempt: state.reviewAttempt + 1 },
  });

  const diffOutput = await ToolManager.execute('git_diff', {});
  if (!diffOutput || diffOutput.trim() === '' || diffOutput.startsWith('Error')) {
    state.onToken?.('✨ **General Review Skipped:** No uncommitted changes detected to review.\n');
    return { reviewCompleted: true };
  }

  const attemptNum = state.reviewAttempt + 1;

  const systemPrompt = `You are a senior code reviewer. Review the following git diff for correctness, maintainability, API design, duplication, and unclear abstractions. For each issue, cite file and approximate line numbers, explain the problem succinctly, and propose a fix. If the diff is clean and has no actionable issues, output the exact word: NO_REVIEW_ISSUES_FOUND.`;

  const reviewPrompt = `Please review the following code diff:\n\n\`\`\`diff\n${diffOutput}\n\`\`\``;

  try {
    const settings = AIService.getSettings();
    const coderModel = settings.coderModel || settings.chatModel;

    const { token: cancelToken, cleanup } = createCancellationTokenFromState(state);
    let llmResult;
    try {
      llmResult = await AIService.streamResponseDetailed(
        [{ role: 'user', content: reviewPrompt, timestamp: Date.now() }],
        systemPrompt,
        () => {},
        state.modelConfig?.modelId || coderModel || undefined,
        state.modelConfig?.provider || undefined,
        0.2,
        cancelToken,
        { enableTools: false }
      );
    } finally {
      cleanup();
    }

    const reviewerOutput = llmResult.text.trim();
    if (reviewerOutput.includes('NO_REVIEW_ISSUES_FOUND')) {
      state.onToken?.('\n✨ **General Review Passed:** No significant maintainability or API issues found.\n');
      return { reviewCompleted: true, reviewAttempt: attemptNum };
    } else {
      state.onToken?.(`\n⚠️ **General Review Found Potential Issues (Attempt ${attemptNum}/${state.maxReviews}):**\n${reviewerOutput}\n`);
      const fixMessage: ChatMessage = {
        role: 'user',
        content: `The general reviewer identified the following issues:\n\n${reviewerOutput}\n\nYou MUST fix these issues. Output the JSON tool call(s) to apply the fixes.`,
        timestamp: Date.now(),
      };
      return {
        chatHistory: [fixMessage],
        reviewCompleted: false,
        reviewAttempt: attemptNum,
        compileCompleted: false,
        testCompleted: false,
      };
    }
  } catch (err: any) {
    state.onToken?.(`\n\n❌ **General Review Error:** ${err.message}\n`);
    return { reviewCompleted: true, reviewAttempt: attemptNum };
  }
}

function getCompileErrorFingerprint(output: string): string {
  if (!output) return '';
  // Extract TypeScript, npm, Python, or linter errors
  const errRegex = /(?:error TS\d+|ERROR in|\[tsl\] ERROR|SyntaxError|AssertionError|Error:|FAIL| ❯ | ✗ )[^\n]*/g;
  const matches = output.match(errRegex);
  if (matches && matches.length > 0) {
    return matches.map(m => m.trim().replace(/\s+/g, ' ')).join('|');
  }
  return output.substring(0, 500).replace(/\s+/g, ' ').trim();
}

/**
 * Helper to compute a normalized tool call fingerprint for loop detection.
 */
function getToolCallFingerprint(call: ToolCall): string {
  const name = call.name;
  if (name === 'edit_file') {
    const filePath = call.arguments?.file_path || '';
    const targetContent = call.arguments?.target_content || '';
    const replacementContent = call.arguments?.replacement_content || '';
    // Normalize all whitespace/newlines
    const normTarget = targetContent.replace(/\s+/g, ' ').trim();
    const normReplacement = replacementContent.replace(/\s+/g, ' ').trim();
    return `edit_file|${filePath}|${normTarget}|${normReplacement}`;
  }
  // For other tools, sort keys to be deterministic and normalize whitespace in string values
  const sortedArgs: Record<string, any> = {};
  if (call.arguments && typeof call.arguments === 'object') {
    for (const key of Object.keys(call.arguments).sort()) {
      const val = call.arguments[key];
      sortedArgs[key] = typeof val === 'string' ? val.replace(/\s+/g, ' ').trim() : val;
    }
  }
  return `${name}|${JSON.stringify(sortedArgs)}`;
}

/**
 * General-purpose loop detector that catches ALL types of agent repetition:
 * 1. Same tool call with same arguments repeated 3+ times
 * 2. Same file read 4+ times in recent history
 * 3. Same file written/edited 3+ times (regardless of compile status)
 * 4. Any single tool name called 6+ times in recent turns
 * Returns a human-readable reason string if a loop is detected, null otherwise.
 */
function detectAgentLoop(chatHistory: ChatMessage[]): string | null {
  // Only look at the last 20 messages to keep detection fast and focused on recent activity
  const recentMessages = chatHistory.slice(-20);

  // Collect all tool calls from recent tool_result messages
  const fileReadCounts: Record<string, number> = {};
  const fileWriteCounts: Record<string, number> = {};
  const toolNameCounts: Record<string, number> = {};

  const pathRegex = /Success: (?:Edited file:|Wrote to file:|Patched lines .*? in file:)\s*([^\s\n]+)/i;
  // Match tool_result blocks: <tool_result name="tool_name"> ... </tool_result>
  const toolResultRegex = /<tool_result name="([^"]+)">/g;

  for (const msg of recentMessages) {
    if (msg.role !== 'user') continue;

    // Parse tool results
    let match;
    toolResultRegex.lastIndex = 0;
    while ((match = toolResultRegex.exec(msg.content)) !== null) {
      const toolName = match[1];
      toolNameCounts[toolName] = (toolNameCounts[toolName] || 0) + 1;
    }

    // Track file reads
    if (msg.content.includes('<tool_result name="read_file">')) {
      const readPathMatch = msg.content.match(/<tool_result name="read_file">\n([\s\S]*?)<\/tool_result>/);
      if (readPathMatch) {
        const contentHash = readPathMatch[1].substring(0, 200);  // First 200 chars as a fingerprint
        fileReadCounts[contentHash] = (fileReadCounts[contentHash] || 0) + 1;
      }
    }

    // Track file writes/edits via the Success: prefix
    const writeMatch = msg.content.match(pathRegex);
    if (writeMatch) {
      const filePath = path.normalize(writeMatch[1]);
      fileWriteCounts[filePath] = (fileWriteCounts[filePath] || 0) + 1;
    }
  }

  // Also scan assistant messages for repeated identical tool calls using ToolManager parser
  const assistantToolCalls: ToolCall[] = [];
  for (const msg of recentMessages) {
    if (msg.role !== 'assistant') continue;
    try {
      const parsed = ToolManager.parseToolCalls(msg.content);
      if (parsed && parsed.length > 0) {
        assistantToolCalls.push(...parsed);
      }
    } catch {
      // Ignore parsing errors here
    }
  }

  const assistantFingerprints = assistantToolCalls.map(getToolCallFingerprint);

  // 1. Check for consecutive identical/near-identical tool calls of ANY tool
  if (assistantFingerprints.length >= 3) {
    const last = assistantFingerprints[assistantFingerprints.length - 1];
    let count = 0;
    for (let i = assistantFingerprints.length - 1; i >= 0; i--) {
      if (assistantFingerprints[i] === last) count++;
      else break;
    }
    if (count >= 3) {
      const toolName = last.split('|')[0];
      return `Repeated identical/near-identical \`${toolName}\` call ${count} times consecutively`;
    }
  }

  // 2. Check for same editing/writing tool call anywhere in recent history (even if interspersed)
  const editTools = ['edit_file', 'write_file', 'patch_file_lines', 'insert_file_lines', 'run_speculative_patch'];
  const fingerprintCounts: Record<string, number> = {};
  for (const fp of assistantFingerprints) {
    fingerprintCounts[fp] = (fingerprintCounts[fp] || 0) + 1;
    const toolName = fp.split('|')[0];
    if (editTools.includes(toolName) && fingerprintCounts[fp] >= 3) {
      return `Repeated editing/writing \`${toolName}\` call ${fingerprintCounts[fp]} times in recent history with near-identical arguments`;
    }
  }

  // Check for same file read too many times
  for (const [key, count] of Object.entries(fileReadCounts)) {
    if (count >= 4) {
      return `Same file read ${count} times in recent history`;
    }
  }

  // Check for same file written/edited too many times
  for (const [filePath, count] of Object.entries(fileWriteCounts)) {
    if (count >= 3) {
      return `File \`${filePath}\` written/edited ${count} times in recent history`;
    }
  }

  // Check for any single tool called too many times
  for (const [toolName, count] of Object.entries(toolNameCounts)) {
    const isMcp = toolName.startsWith('mcp__');
    const isReadOnly = [
      'read_file', 'list_dir', 'grep_search', 'web_search', 'fetch_webpage', 'web_scrape',
      'get_library_docs', 'get_diagnostics', 'get_active_editor_context', 'search_workspace_symbols',
      'find_references', 'find_definitions', 'get_vscode_extensions', 'get_vscode_settings'
    ].includes(toolName);
    const isCommand = toolName === 'run_command';

    if (isMcp || isReadOnly || isCommand) {
      if (count >= 20) {
        return `Tool \`${toolName}\` called ${count} times in recent turns`;
      }
    } else {
      if (count >= 8) {
        return `Tool \`${toolName}\` called ${count} times in recent turns`;
      }
    }
  }

  return null;
}

function routeToFinalizeOrAudit(state: AgentStateType): string {
  if (state.codeChangesMade && !state.auditCompleted && state.auditAttempt < state.maxAudits && state.currentSubagentId !== 'security-reviewer') {
    return 'runSecurityAudit';
  }
  // If code changes were made and security audit completed, run a general review pass
  if (state.codeChangesMade && !state.reviewCompleted && state.reviewAttempt < state.maxReviews) {
    return 'runGeneralReview';
  }
  return 'finalize';
}

// ─────────────────────────────────────────────────────────────
// 3. Routing Functions (Conditional Edges)
// ─────────────────────────────────────────────────────────────

function findTaskFile(dir: string, depth = 0): string | null {
  // Direct check first for speed and workspace cleanliness
  try {
    const directPath = path.join(dir, '.k-horizon', 'task.md');
    if (fs.existsSync(directPath)) {
      return directPath;
    }
    const rootPath = path.join(dir, 'task.md');
    if (fs.existsSync(rootPath)) {
      return rootPath;
    }
  } catch (e) {
    // Ignore direct check errors
  }

  if (depth > 2) return null;
  try {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      if (item.toLowerCase() === 'node_modules' || item.toLowerCase() === '.git') continue;
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        const found = findTaskFile(fullPath, depth + 1);
        if (found) return found;
      } else if (item.toLowerCase() === 'task.md') {
        return fullPath;
      }
    }
  } catch (e) {
    // Ignore
  }
  return null;
}

function extractInitialUserPrompt(chatHistory: ChatMessage[]): string {
  let humanMsg = [...chatHistory].reverse().find(m => m.role === 'user' && m.content.includes('User Request:\n'));
  if (!humanMsg) {
    humanMsg = [...chatHistory].reverse().find(m => m.role === 'user');
  }
  const fullUserContent = humanMsg ? humanMsg.content : '';
  const userRequestMatch = fullUserContent.match(/User Request:\n([\s\S]*)$/);
  return userRequestMatch ? userRequestMatch[1] : fullUserContent;
}

function shouldGenerateImplementationPlan(state: AgentStateType): boolean {
  const prompt = extractInitialUserPrompt(state.chatHistory).trim();
  if (!prompt) return false;

  const nonTrivialIndicators = [
    /\b(create|build|implement|refactor|rewrite|redesign|add|remove|update|fix|migrate|extend)\b/i,
    /\b(api|component|page|screen|route|feature|workflow|model|service|test|tool|agent)\b/i,
    /\b(multi-file|workspace|monorepo|architecture|roadmap|plan)\b/i,
  ];

  return prompt.length >= 80 || nonTrivialIndicators.some(pattern => pattern.test(prompt));
}

function formatPlanFiles(plan: {
  title: string;
  summary: string;
  tasks: string[];
  verification: string[];
}): { implementationPlan: string; taskList: string } {
  const implementationPlan = [
    `# ${plan.title}`,
    '',
    '## Summary',
    plan.summary.trim(),
    '',
    '## Tasks',
    ...plan.tasks.map(task => `- [ ] ${task}`),
    '',
    '## Verification',
    ...plan.verification.map(step => `- ${step}`),
  ].join('\n');

  const taskList = [
    '# Task List',
    ...plan.tasks.map(task => `- [ ] ${task}`),
  ].join('\n');

  return { implementationPlan, taskList };
}

async function prepareImplementationPlan(state: AgentStateType): Promise<Partial<AgentStateType>> {
  if (!state.isRunning || state.checkCancellation?.()) {
    return {};
  }

  const workspaceRoot = state.workspaceRoot || getWorkspaceRoot();
  if (!workspaceRoot || !shouldGenerateImplementationPlan(state)) {
    return { implementationPlanSummary: '' };
  }

  const prompt = extractInitialUserPrompt(state.chatHistory).trim();
  const planDir = path.join(workspaceRoot, '.k-horizon');
  const planPath = path.join(planDir, 'implementation_plan.md');
  const taskPath = path.join(planDir, 'task.md');

  const fallbackPlan = {
    title: 'Implementation Plan',
    summary: `Implement the user's request: ${prompt}`,
    tasks: [
      'Inspect the relevant files and current implementation',
      'Make the required code changes',
      'Run compile and targeted tests',
      'Write a brief walkthrough of the changes',
    ],
    verification: ['npm run compile', 'npm run test:unit'],
  };

  try {
    fs.mkdirSync(planDir, { recursive: true });

    const settings = AIService.getSettings();
    const plannerModel = state.modelConfig?.modelId || settings.plannerModel || settings.chatModel || undefined;
    const provider = state.modelConfig?.provider || settings.provider || undefined;
    const systemPrompt = `You are a senior software planner.
Create a concise implementation plan for the user's request.

Return ONLY valid JSON with this shape:
{
  "title": "Short title",
  "summary": "2-4 sentence summary of the approach",
  "tasks": ["task 1", "task 2"],
  "verification": ["step 1", "step 2"]
}

Rules:
- Keep tasks concrete and ordered.
- Prefer small, verifiable steps.
- Include verification steps that match the repo's compile/test workflow.`;

    // Inject continuous learnings into the planner system prompt so past corrections
    // and rules influence planning and tool selection.
    let plannerSystemPrompt = systemPrompt;
    try {
      const learningsPrompt = await AgentLearningManager.loadLearningsAsPrompt(workspaceRoot);
      if (learningsPrompt) plannerSystemPrompt = plannerSystemPrompt + '\n\n' + learningsPrompt;
    } catch {}

    const { token: cancelToken, cleanup } = createCancellationTokenFromState(state);
    let llmResult;
    try {
      llmResult = await AIService.streamResponseDetailed(
        [{ role: 'user', content: `User request:\n${prompt}`, timestamp: Date.now() }],
        plannerSystemPrompt,
        () => {},
        plannerModel,
        provider,
        0.2,
        cancelToken,
        { enableTools: false }
      );
    } finally {
      cleanup();
    }

    const rawText = ToolManager.stripReasoningFromText(llmResult.text || '');
    const match = rawText.match(/\{[\s\S]*\}/);

    let parsed = fallbackPlan;
    if (match) {
      try {
        const candidate = JSON.parse(match[0]);
        if (candidate && typeof candidate === 'object') {
          const tasks = Array.isArray(candidate.tasks) ? candidate.tasks.map(String).filter(Boolean) : fallbackPlan.tasks;
          const verification = Array.isArray(candidate.verification) ? candidate.verification.map(String).filter(Boolean) : fallbackPlan.verification;
          parsed = {
            title: typeof candidate.title === 'string' && candidate.title.trim() ? candidate.title.trim() : fallbackPlan.title,
            summary: typeof candidate.summary === 'string' && candidate.summary.trim() ? candidate.summary.trim() : fallbackPlan.summary,
            tasks: tasks.length > 0 ? tasks : fallbackPlan.tasks,
            verification: verification.length > 0 ? verification : fallbackPlan.verification,
          };
        }
      } catch {
        parsed = fallbackPlan;
      }
    }

    const formatted = formatPlanFiles(parsed);
    fs.writeFileSync(planPath, formatted.implementationPlan, 'utf8');
    fs.writeFileSync(taskPath, formatted.taskList, 'utf8');

    return {
      implementationPlanSummary: [
        `# ${parsed.title}`,
        '',
        parsed.summary,
        '',
        '## Tasks',
        ...parsed.tasks.map(task => `- ${task}`),
        '',
        '## Verification',
        ...parsed.verification.map(step => `- ${step}`),
      ].join('\n'),
    };
  } catch (err: any) {
    console.error('[prepareImplementationPlan] Failed to create plan files:', err);
    const formatted = formatPlanFiles(fallbackPlan);
    try {
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(planPath, formatted.implementationPlan, 'utf8');
      fs.writeFileSync(taskPath, formatted.taskList, 'utf8');
    } catch {
      // ignore fallback write errors
    }
    return {
      implementationPlanSummary: [
        `# ${fallbackPlan.title}`,
        '',
        fallbackPlan.summary,
        '',
        '## Tasks',
        ...fallbackPlan.tasks.map(task => `- ${task}`),
        '',
        '## Verification',
        ...fallbackPlan.verification.map(step => `- ${step}`),
      ].join('\n'),
    };
  }
}

export function routeAfterParse(state: AgentStateType): string {
  if (!state.isRunning) return 'finalize';

  // ── General loop detection ────────────────────────────────────────────
  const loopReason = detectAgentLoop(state.chatHistory);
  if (loopReason) {
    state.onToken?.(`\n\n⚠️ **Agent loop detected: ${loopReason}. Stopping to prevent token drain.**\n`);
    return 'summarizeAndAskUser';
  }

  // ── Tool calls pending → execute them ─────────────────────────────────
  if (state.pendingToolCalls && state.pendingToolCalls.length > 0) {
    return 'executeTools';
  }

  // ── Self-heal: awaiting fix response ──────────────────────────────────
  if (state.awaitingSelfHealResponse) {
    if (state.consecutiveTextOnlyHealResponses >= 3) {
      return 'summarizeAndAskUser';
    }
    return 'checkSelfHeal';
  }

  // ── Reprompt for tool execution (text-only response on action request) ─
  const initialUserPrompt = extractInitialUserPrompt(state.chatHistory);
  const hasActionKeywords = /delete|create|fix|run|write|edit|add|remove|update|change|make|install|uninstall/i.test(initialUserPrompt);
  const shouldKeepWorking = !state.codeChangesMade 
    && hasActionKeywords 
    && state.loopCount <= 15
    && state.consecutiveReprompts < 2;
  if (state.loopCount < state.maxLoops && shouldKeepWorking) {
    return 'repromptToolCall';
  }

  // ── Unfinished tasks check ────────────────────────────────────────────
  if (state.workspaceRoot && state.continueTaskReprompts < 2) {
    const taskFilePath = findTaskFile(state.workspaceRoot);
    if (taskFilePath && fs.existsSync(taskFilePath)) {
      const taskContent = fs.readFileSync(taskFilePath, 'utf8');
      if (taskContent.includes('- [ ]')) {
        return 'continueUnfinishedTasks';
      }
    }
  }

  return routeToFinalizeOrAudit(state);
}

export function routeFromSelfHeal(state: AgentStateType): string {
  if (!state.isRunning) return 'finalize';
  // Only run auto-compile/auto-test if code changes were made OR if the user explicitly asked for it
  // (We check for explicit requests by looking at the user prompt for compile/test keywords)
  const initialUserPrompt = extractInitialUserPrompt(state.chatHistory);
  const explicitlyRequestedCompile = /compile|build/i.test(initialUserPrompt);
  const explicitlyRequestedTest = /test|spec/i.test(initialUserPrompt);
  
  const shouldCompile = state.autoCompile && !state.compileCompleted && (state.codeChangesMade || explicitlyRequestedCompile);
  const shouldTest = state.autoTest && !state.testCompleted && (state.codeChangesMade || explicitlyRequestedTest);
  
  if (shouldCompile) return 'runCompile';
  if (shouldTest) return 'runTest';
  return routeToFinalizeOrAudit(state);
}

export function routeAfterCompile(state: AgentStateType): string {
  if (!state.isRunning) return 'finalize';
  if (!state.compileCompleted) return 'callLLM';

  const initialUserPrompt = extractInitialUserPrompt(state.chatHistory);
  const explicitlyRequestedTest = /test|spec/i.test(initialUserPrompt);

  const shouldTest = state.autoTest && !state.testCompleted && (state.codeChangesMade || explicitlyRequestedTest);
  if (shouldTest) return 'runTest';
  return routeToFinalizeOrAudit(state);
}

export function routeAfterTest(state: AgentStateType): string {
  if (!state.isRunning) return 'finalize';
  if (!state.testCompleted) return 'callLLM';
  return routeToFinalizeOrAudit(state);
}

export function routeAfterAudit(state: AgentStateType): string {
  if (!state.isRunning) return 'finalize';
  if (!state.auditCompleted) return 'callLLM';
  return routeToFinalizeOrAudit(state);
}

// ─────────────────────────────────────────────────────────────
// 4. Placeholder Nodes
// ─────────────────────────────────────────────────────────────

/**
 * Real decision node replacing the previous no-op.
 *
 * When the LLM responds to a self-heal fix prompt with prose instead of a `tool_call`
 * block, this node decides what to do next instead of blindly passing through:
 *   1. If the response actually contained a `tool_call` block → clear the text-only
 *      counter and let `routeFromSelfHeal` decide compile vs test vs finalize.
 *   2. If the response is text-only → bump `consecutiveTextOnlyHealResponses` and
 *      inject a sharper re-prompt with instructions to read the file first.
 *   3. After 3 consecutive text-only responses, route to `summarizeAndAskUser`
 *      (via `routeAfterParse`) instead of burning another turn.
 *
 * Previously this returned `{}` and the graph fell straight through to `finalize`,
 * which is why a model that wrote prose instead of a `tool_call` produced a "verified"
 * result without any verification actually running.
 */
async function checkSelfHeal(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const response = state.lastAssistantResponse || '';
  // Detect a "real" tool call by running the response through the same
  // parser the agent loop uses (JSON-first, XML fallback). If it yields at
  // least one ToolCall, treat the response as actionable and skip the
  // text-only branch. This keeps the detector in lockstep with the parser
  // contract: anything ToolManager can execute counts as a tool call.
  const looksLikeToolCall = ToolManager.parseToolCalls(response).length > 0;
  const isEmpty = response.trim() === '';

  if (isEmpty) {
    state.onToken?.('\n\n⚠️ Self-heal got an empty response. Stopping.\n');
    return {
      awaitingSelfHealResponse: false,
      isRunning: false,
      consecutiveTextOnlyHealResponses: 0,
    };
  }

  if (!looksLikeToolCall) {
    const nextCount = state.consecutiveTextOnlyHealResponses + 1;
    state.onToken?.(`\n\n🤖 Self-heal text-only response (${nextCount}/3). Re-prompting.\n`);
    const repromptMsg: ChatMessage = {
      role: 'user',
      content: `You responded with prose to the previous fix prompt, but the build is still failing. You MUST emit the actual JSON tool call now to fix the error — {\"name\": \"edit_file\", \"arguments\": {...}} or an array of such calls. Do NOT explain in markdown code blocks. Do NOT describe what you would do. Output the raw JSON tool_call now.

If you are unsure what change to make, read the relevant file first with a {\"name\": \"read_file\", \"arguments\": {\"file_path\": \"...\"}} call before editing.`,
      timestamp: Date.now(),
    };
    return {
      chatHistory: [repromptMsg],
      awaitingSelfHealResponse: true,
      consecutiveTextOnlyHealResponses: nextCount,
    };
  }

  // Looks like a tool call — clear the text-only counter and let routing decide.
  return {
    awaitingSelfHealResponse: false,
    consecutiveTextOnlyHealResponses: 0,
  };
}

/**
 * Force-finalize node used when the model has produced 2+ consecutive text-only
 * responses during a self-heal loop. Rather than burn another turn, surface a
 * concise summary of the blocker to the user and stop.
 */
async function summarizeAndAskUser(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const phase = state.compileHealAttempts > state.testHealAttempts ? 'compile' : 'test';
  const attempts = phase === 'compile' ? state.compileHealAttempts : state.testHealAttempts;
  const lastResponse = state.lastAssistantResponse || '(no assistant response)';
  const summary = `\n\n🛑 **Self-heal loop stalled:** The agent responded with text instead of a JSON tool call ${state.consecutiveTextOnlyHealResponses} times in a row while trying to fix the ${phase} failure (attempt ${attempts}/3).\n\nLast response preview:\n\`\`\`\n${lastResponse.slice(0, 600)}\n\`\`\`\n\nPlease provide a hint about what to change, or paste the exact error message you want fixed. The agent will resume from here on your next message.`;
  state.onToken?.(summary);
  return {
    isRunning: false,
    awaitingSelfHealResponse: false,
    consecutiveTextOnlyHealResponses: 0,
    finalResponse: summary,
  };
}

async function repromptToolCall(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const nextCount = (state.consecutiveReprompts || 0) + 1;
  state.onToken?.(`\n\n🤖 Reprompting for tool execution (${nextCount}/2)...\n`);
  
  let repromptText = `You responded with text only, but the request requires action. You MUST output the actual JSON tool call now to execute the changes — {"name": "edit_file", "arguments": {...}} or an array of such calls. Do not explain, do not output markdown code blocks. Output ONLY the tool calls.`;
  if (state.lastParserError) {
    repromptText = `Your last response failed to parse as a valid JSON tool call:\n\n${state.lastParserError}\n\nPlease correct the syntax/structure and output the valid JSON tool call now. Do not explain, do not output markdown code blocks. Output ONLY the tool calls.`;
  }

  const repromptMsg: ChatMessage = {
    role: 'user',
    content: repromptText,
    timestamp: Date.now()
  };
  return {
    chatHistory: [repromptMsg],
    consecutiveReprompts: nextCount,
  };
}

async function continueUnfinishedTasks(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const nextCount = (state.continueTaskReprompts || 0) + 1;
  state.onToken?.(`\n\n🤖 Unfinished tasks found. Continuing (${nextCount}/2)...\n`);
  const repromptMsg: ChatMessage = {
    role: 'user',
    content: `You have uncompleted tasks remaining in your task list (task.md). Please continue implementing the remaining files and tasks in your plan. Output the actual JSON tool calls now to execute the changes — {"name": "edit_file", "arguments": {...}} or an array of such calls.`,
    timestamp: Date.now()
  };
  return {
    chatHistory: [repromptMsg],
    continueTaskReprompts: nextCount,
  };
}

async function finalize(_state: AgentStateType): Promise<Partial<AgentStateType>> {
  AgentTrace.append({
    runId: _state.runId || 'unknown',
    sessionId: _state.sessionId,
    type: 'run_finalize',
    timestamp: Date.now(),
    data: { loopCount: _state.loopCount },
  });

  const enableContinuousLearning = vscode.workspace.getConfiguration('k-horizon').get<boolean>('enableContinuousLearning', true);

  if (enableContinuousLearning && _state.workspaceRoot) {
    // Dynamic import to avoid circular dependencies
    import('./learning-manager').then(async ({ AgentLearningManager }) => {
      // Runs silently in the background
      await AgentLearningManager.reflectAndLearn(
        _state.workspaceRoot,
        _state.chatHistory,
        _state.compileHealAttempts,
        _state.testHealAttempts,
        _state.modelConfig?.modelId
      );
    }).catch(err => {
      console.error('[finalize] Dynamic import of learning-manager failed:', err);
    });
  }

  return {};
}

// ─────────────────────────────────────────────────────────────
// 5. Graph Builder
// ─────────────────────────────────────────────────────────────

/**
 * Creates and compiles the K-Horizon agent StateGraph.
 * A MemorySaver checkpointer is attached so users can resume interrupted
 * agent sessions via the thread_id parameter at invoke() time.
 */
export function createAgentGraph() {
  const workflow = new StateGraph(AgentState)
    .addNode('prepareImplementationPlan', prepareImplementationPlan)
    .addNode('callLLM', callLLM)
    .addNode('parseToolCalls', parseToolCalls)
    .addNode('executeTools', executeTools)
    .addNode('checkSelfHeal', checkSelfHeal)
    .addNode('repromptToolCall', repromptToolCall)
    .addNode('continueUnfinishedTasks', continueUnfinishedTasks)
    .addNode('summarizeAndAskUser', summarizeAndAskUser)
    .addNode('runCompile', runCompile)
    .addNode('runTest', runTest)
    .addNode('runSecurityAudit', runSecurityAudit)
    .addNode('runGeneralReview', runGeneralReview)
    .addNode('finalize', finalize)

    .addEdge(START, 'prepareImplementationPlan')
    .addEdge('prepareImplementationPlan', 'callLLM')
    .addEdge('callLLM', 'parseToolCalls')

    .addConditionalEdges('parseToolCalls', routeAfterParse, {
      executeTools: 'executeTools',
      repromptToolCall: 'repromptToolCall',
      checkSelfHeal: 'checkSelfHeal',
      summarizeAndAskUser: 'summarizeAndAskUser',
      finalize: 'finalize',
      continueUnfinishedTasks: 'continueUnfinishedTasks',
      runSecurityAudit: 'runSecurityAudit',
      runGeneralReview: 'runGeneralReview',
    })

    .addEdge('summarizeAndAskUser', 'finalize')

    .addEdge('executeTools', 'callLLM')
    .addEdge('repromptToolCall', 'callLLM')
    .addEdge('continueUnfinishedTasks', 'callLLM')

    .addConditionalEdges('checkSelfHeal', routeFromSelfHeal, {
      runCompile: 'runCompile',
      runTest: 'runTest',
      runSecurityAudit: 'runSecurityAudit',
      runGeneralReview: 'runGeneralReview',
      finalize: 'finalize',
    })

    .addConditionalEdges('runCompile', routeAfterCompile, {
      callLLM: 'callLLM',
      runTest: 'runTest',
      runSecurityAudit: 'runSecurityAudit',
      runGeneralReview: 'runGeneralReview',
      finalize: 'finalize',
    })

    .addConditionalEdges('runTest', routeAfterTest, {
      callLLM: 'callLLM',
      runSecurityAudit: 'runSecurityAudit',
      runGeneralReview: 'runGeneralReview',
      finalize: 'finalize',
    })

    .addConditionalEdges('runSecurityAudit', routeAfterAudit, {
      callLLM: 'callLLM',
      runGeneralReview: 'runGeneralReview',
      finalize: 'finalize',
    })

    .addConditionalEdges('runGeneralReview', (s: AgentStateType) => {
      if (!s.isRunning) return 'finalize';
      // If review is not completed, we want the model to respond (callLLM) so it can emit fixes;
      // otherwise finalize.
      return s.reviewCompleted ? 'finalize' : 'callLLM';
    }, {
      callLLM: 'callLLM',
      finalize: 'finalize',
    })

    .addEdge('finalize', END);

  // In-memory checkpointer. Swap for SqliteSaver / PostgresSaver for
  // production persistence. See @langchain/langgraph-checkpoint.
  const checkpointer = new MemorySaver();
  return workflow.compile({ checkpointer });
}
