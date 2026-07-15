import * as vscode from 'vscode';
import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import { exec, execSync } from 'child_process';
import * as os from 'os';
import * as https from 'https';
import type { CheerioAPI } from 'cheerio';
import { MCPManager } from './mcp-manager';
import { parseCommandFailure, inspectPlannedCommand } from './npm-error-parser';
import { ASTParser } from './ast-parser';
import { DBClient } from './db-client';
import { AgentLearningManager } from './learning-manager';
import { AIService } from './ai-service';
import { detectVerificationCommands } from './verification-commands';
import { getWorkspaceRoot } from './workspace-utils';

export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

type PathResolution = { ok: true; absolutePath: string } | { ok: false; error: string };
type ToolSchemaFormat = 'openai' | 'anthropic';

interface ToolSchemaSpec {
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
}

export class ToolManager {
  private static activeProcesses = new Set<any>();
  public static lastParserError: string | null = null;
  private static webSearchCount = 0;
  private static activeBrowserCount = 0;
  private static browserQueue: (() => void)[] = [];

  private static async acquireBrowserSlot(): Promise<void> {
    if (this.activeBrowserCount < 2) {
      this.activeBrowserCount++;
      return;
    }
    return new Promise<void>(resolve => {
      this.browserQueue.push(resolve);
    });
  }

  private static releaseBrowserSlot(): void {
    if (this.browserQueue.length > 0) {
      const next = this.browserQueue.shift();
      if (next) next();
    } else {
      this.activeBrowserCount = Math.max(0, this.activeBrowserCount - 1);
    }
  }

  public static resetWebSearchCount() {
    this.webSearchCount = 0;
  }
  private static readonly requiredToolArgs: Record<string, string[]> = {
    list_dir: [],
    read_file: ['file_path'],
    write_file: ['file_path', 'content'],
    edit_file: ['file_path', 'target_content', 'replacement_content'],
    delete_file: ['file_path'],
    grep_search: ['query'],
    web_search: ['query'],
    fetch_webpage: ['url'],
    run_command: ['command'],
    get_active_editor_context: [],
    get_diagnostics: [],
    preview_html: [],
    execute_vscode_command: ['command_id'],
    find_files: ['pattern'],
    get_file_outline: ['file_path'],
    git_status: [],
    git_diff: [],
    web_scrape: ['url'],
    get_library_docs: ['library_name'],
    search_workspace_symbols: ['query'],
    find_references: ['file_path', 'line', 'character'],
    find_definitions: ['file_path', 'line', 'character'],
    trace_symbol_dependency: ['symbol_name'],
    show_info_message: ['message'],
    get_vscode_extensions: [],
    send_to_terminal: ['command'],
    open_file_to_side: ['file_path'],
    verify_edit: ['file_path'],
    switch_subagent: ['subagent_id'],
    create_webhook_token: [],
    get_webhook_requests: ['token_id'],
    // ── Legacy file-modification tools ─────────────────────────────────
    // The model only sees read_file, write_file, and edit_file in its
    // native tool schema. These legacy entries are kept so that older
    // tests, the in-process tool dispatcher, and any persisted tool-call
    // transcripts still work. They are routed to the canonical
    // implementation in `execute()` (search for `LEGACY_TOOL_ALIASES`).
    patch_file_lines: ['file_path', 'start_line', 'end_line', 'replacement_content'],
    replace_in_files: ['query', 'replacement'],
    insert_file_lines: ['file_path', 'line_number', 'content'],
    run_speculative_patch: ['file_path', 'target_content', 'replacement_content', 'validation_command'],
    run_speculative_workspace_patch: ['patches_json', 'validation_command'],
    // ──────────────────────────────────────────────────────────────────
    get_file_metadata: ['file_path'],
    create_directory: ['directory_path'],
    git_diff_file: ['file_path'],
    copy_file: ['source_path', 'destination_path'],
    move_file: ['source_path', 'destination_path'],
    synthesize_custom_tool: ['tool_name', 'description', 'required_args_json', 'properties_json', 'code'],
    capture_page_screenshot: ['url'],
    update_dependency_graph: [],
    request_hunk_reviews: ['diffs_json'],
    run_fuzz_test: ['file_path', 'export_name'],
    db_query: ['query'],
    db_status: [],
    get_learning_rules: [],
    find_learning_rules: ['query'],
    add_learning_rule: ['mistake', 'correction'],
    gather_failure_diagnostics: ['command'],
    delete_learning_rule: ['rule_id'],
    get_vscode_settings: [],
    update_vscode_settings: ['key', 'value_json'],
    toggle_autocomplete: ['enabled'],
  };

  private static readonly manualAliases: Record<string, Record<string, string>> = {
    edit_file: {
      // file_path aliases
      path: 'file_path',
      file: 'file_path',
      filename: 'file_path',
      file_name: 'file_path',
      filepath: 'file_path',
      // target_content aliases – single word
      target: 'target_content',
      find: 'target_content',
      search: 'target_content',
      original: 'target_content',
      old: 'target_content',
      before: 'target_content',
      existing: 'target_content',
      current: 'target_content',
      source: 'target_content',
      match: 'target_content',
      // target_content aliases – compound words (Claude, GPT, Gemini variants)
      old_text: 'target_content',
      old_string: 'target_content',
      old_content: 'target_content',
      old_code: 'target_content',
      old_value: 'target_content',
      search_text: 'target_content',
      search_string: 'target_content',
      search_content: 'target_content',
      find_text: 'target_content',
      find_string: 'target_content',
      find_content: 'target_content',
      original_text: 'target_content',
      original_string: 'target_content',
      original_content: 'target_content',
      original_code: 'target_content',
      existing_text: 'target_content',
      existing_string: 'target_content',
      existing_content: 'target_content',
      existing_code: 'target_content',
      current_text: 'target_content',
      current_string: 'target_content',
      current_content: 'target_content',
      current_code: 'target_content',
      source_text: 'target_content',
      source_string: 'target_content',
      source_content: 'target_content',
      before_text: 'target_content',
      before_content: 'target_content',
      before_string: 'target_content',
      content_to_replace: 'target_content',
      text_to_replace: 'target_content',
      string_to_replace: 'target_content',
      code_to_replace: 'target_content',
      match_text: 'target_content',
      match_string: 'target_content',
      match_content: 'target_content',
      // replacement_content aliases – single word
      replacement: 'replacement_content',
      replace: 'replacement_content',
      new: 'replacement_content',
      after: 'replacement_content',
      updated: 'replacement_content',
      modified: 'replacement_content',
      result: 'replacement_content',
      // replacement_content aliases – compound words
      new_text: 'replacement_content',
      new_string: 'replacement_content',
      new_content: 'replacement_content',
      new_code: 'replacement_content',
      new_value: 'replacement_content',
      replace_text: 'replacement_content',
      replace_string: 'replacement_content',
      replace_content: 'replacement_content',
      replace_with: 'replacement_content',
      replacement_text: 'replacement_content',
      replacement_string: 'replacement_content',
      replacement_code: 'replacement_content',
      updated_text: 'replacement_content',
      updated_string: 'replacement_content',
      updated_content: 'replacement_content',
      updated_code: 'replacement_content',
      modified_text: 'replacement_content',
      modified_content: 'replacement_content',
      modified_string: 'replacement_content',
      after_text: 'replacement_content',
      after_content: 'replacement_content',
      after_string: 'replacement_content',
      result_text: 'replacement_content',
      result_content: 'replacement_content',
      result_string: 'replacement_content',
      content_replacement: 'replacement_content',
      text_replacement: 'replacement_content',
      insert: 'replacement_content',
      content: 'replacement_content'
    },
    write_file: {
      path: 'file_path',
      file: 'file_path',
      filename: 'file_path',
      file_name: 'file_path',
      filepath: 'file_path',
      text: 'content',
      code: 'content',
      body: 'content',
      data: 'content',
      source: 'content',
      file_content: 'content',
      new_content: 'content',
      file_contents: 'content'
    },
    read_file: {
      path: 'file_path',
      file: 'file_path',
      filename: 'file_path',
      file_name: 'file_path',
      filepath: 'file_path'
    },
    delete_file: {
      path: 'file_path',
      file: 'file_path',
      filename: 'file_path',
      file_name: 'file_path',
      filepath: 'file_path'
    },
    grep_search: {
      search: 'query',
      pattern: 'query',
      term: 'query',
      text: 'query',
      keyword: 'query'
    },
    web_search: {
      search: 'query',
      term: 'query',
      keyword: 'query',
      question: 'query',
      keywords: 'query'
    },
    fetch_webpage: {
      link: 'url',
      uri: 'url',
      webpage: 'url',
      address: 'url'
    },
    run_command: {
      cmd: 'command',
      shell_command: 'command',
      terminal_command: 'command'
    },
    execute_vscode_command: {
      command: 'command_id',
      cmd: 'command_id',
      id: 'command_id'
    },
    find_files: {
      query: 'pattern',
      glob: 'pattern',
      search: 'pattern',
      term: 'pattern',
      file_pattern: 'pattern'
    },
    get_file_outline: {
      path: 'file_path',
      file: 'file_path',
      filename: 'file_path',
      filepath: 'file_path'
    },
    trace_symbol_dependency: {
      symbol: 'symbol_name',
      name: 'symbol_name',
      identifier: 'symbol_name'
    },
    show_info_message: {
      msg: 'message',
      text: 'message',
      info: 'message',
      content: 'message'
    },
    send_to_terminal: {
      cmd: 'command',
      command_line: 'command',
      shell_command: 'command'
    },
    open_file_to_side: {
      path: 'file_path',
      file: 'file_path',
      filename: 'file_path',
      filepath: 'file_path'
    },
    verify_edit: {
      path: 'file_path',
      file: 'file_path',
      filename: 'file_path',
      filepath: 'file_path'
    },
    find_references: {
      path: 'file_path',
      file: 'file_path',
      filename: 'file_path',
      filepath: 'file_path',
      line_number: 'line',
      col: 'character',
      column: 'character',
      char: 'character',
      char_index: 'character',
      character_offset: 'character'
    },
    find_definitions: {
      path: 'file_path',
      file: 'file_path',
      filename: 'file_path',
      filepath: 'file_path',
      line_number: 'line',
      col: 'character',
      column: 'character',
      char: 'character',
      char_index: 'character',
      character_offset: 'character'
    },
    switch_subagent: {
      subagent: 'subagent_id',
      agent: 'subagent_id',
      id: 'subagent_id'
    }
  };

  /**
   * Maps for fuzzy word-segment matching for `edit_file` required args.
   * Keys are "role words" that appear in the first segment of a compound argument
   * name used by various LLMs. Values are the canonical parameter names.
   */
  private static readonly EDIT_FILE_TARGET_WORDS = new Set([
    'old', 'original', 'existing', 'current', 'source', 'before',
    'find', 'search', 'match', 'target'
  ]);
  private static readonly EDIT_FILE_REPLACEMENT_WORDS = new Set([
    'new', 'replacement', 'replace', 'updated', 'modified', 'after',
    'result', 'insert'
  ]);

  private static normalizeToolArguments(name: string, rawArgs: Record<string, any>): Record<string, any> {
    const isMcp = name.startsWith('mcp__');

    // 1. Get all expected keys for the tool
    let expectedKeys: string[] = [];
    if (isMcp) {
      const parts = name.split('__');
      if (parts.length >= 3) {
        const serverName = parts[1];
        const toolName = parts.slice(2).join('__');
        const mcpTools = MCPManager.getAllTools();
        const matchedMcp = mcpTools.find(t => t.serverName.toLowerCase() === serverName.toLowerCase() && t.name.toLowerCase() === toolName.toLowerCase());
        if (matchedMcp && matchedMcp.inputSchema && matchedMcp.inputSchema.properties) {
          expectedKeys = Object.keys(matchedMcp.inputSchema.properties);
        }
      }
      if (expectedKeys.length === 0) {
        return rawArgs;
      }
    } else {
      const spec = this.toolSpecs[name];
      if (spec && spec.properties) {
        expectedKeys = Object.keys(spec.properties);
      } else {
        const dynamicTools = this.loadDynamicTools();
        if (dynamicTools[name] && dynamicTools[name].properties) {
          expectedKeys = Object.keys(dynamicTools[name].properties);
        } else {
          expectedKeys = this.requiredToolArgs[name] || [];
        }
      }
    }

    // 2. Build clean key lookup map (strips non-alphanumeric, lowercases)
    const cleanKey = (k: string) => k.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const cleanExpectedMap: Record<string, string> = {};
    for (const key of expectedKeys) {
      cleanExpectedMap[cleanKey(key)] = key;
    }

    const manual = this.manualAliases[name];
    const normalized: Record<string, any> = {};

    for (const [key, val] of Object.entries(rawArgs)) {
      const lowerKey = key.toLowerCase();
      const stripped = lowerKey.replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      let targetKey = key;

      // Pass 1 – exact manual alias (handles both single-word and compound-word aliases)
      if (manual && manual[stripped]) {
        targetKey = manual[stripped];
      } else if (manual && manual[lowerKey]) {
        targetKey = manual[lowerKey];
      } else {
        // Pass 2 – exact clean match (camelCase / PascalCase collapse)
        const cleaned = cleanKey(key);
        if (cleanExpectedMap[cleaned]) {
          targetKey = cleanExpectedMap[cleaned];
        } else {
          // Pass 3 – word-segment role matching (for edit_file and patch_file_lines)
          // Split on underscores/camelCase boundaries and inspect the leading segment.
          const segments = stripped.split('_').filter(Boolean);
          if (segments.length >= 1) {
            const leadWord = segments[0];
            if ((name === 'edit_file' || name === 'run_speculative_patch') &&
                !cleanExpectedMap[cleaned]) {
              if (this.EDIT_FILE_TARGET_WORDS.has(leadWord)) {
                targetKey = 'target_content';
              } else if (this.EDIT_FILE_REPLACEMENT_WORDS.has(leadWord)) {
                targetKey = 'replacement_content';
              } else if (leadWord === 'file' || leadWord === 'path') {
                targetKey = 'file_path';
              }
            } else if (name === 'patch_file_lines') {
              if (this.EDIT_FILE_REPLACEMENT_WORDS.has(leadWord)) {
                targetKey = 'replacement_content';
              } else if (leadWord === 'start' || leadWord === 'from') {
                targetKey = 'start_line';
              } else if (leadWord === 'end' || leadWord === 'to') {
                targetKey = 'end_line';
              } else if (leadWord === 'file' || leadWord === 'path') {
                targetKey = 'file_path';
              }
            }
          }
        }
      }

      normalized[targetKey] = val;
    }

    // Pass 4 – General robust heuristic mappings based on expected keys
    for (const key of expectedKeys) {
      if (key === 'path' && !normalized['path']) {
        const val = normalized['file_path'] ?? normalized['filepath'] ?? normalized['file'];
        if (val !== undefined) {
          normalized['path'] = val;
          delete normalized['file_path'];
          delete normalized['filepath'];
          delete normalized['file'];
        }
      }
      if (key === 'file_path' && !normalized['file_path']) {
        const val = normalized['path'] ?? normalized['filepath'] ?? normalized['file'];
        if (val !== undefined) {
          normalized['file_path'] = val;
          delete normalized['path'];
          delete normalized['filepath'];
          delete normalized['file'];
        }
      }
      if (key === 'content' && !normalized['content']) {
        const val = normalized['text'] ?? normalized['code'] ?? normalized['file_content'] ?? normalized['filecontent'];
        if (val !== undefined) {
          normalized['content'] = val;
          delete normalized['text'];
          delete normalized['code'];
          delete normalized['file_content'];
          delete normalized['filecontent'];
        }
      }
      if (key === 'replacement_content' && !normalized['replacement_content']) {
        const val = normalized['content'] ?? normalized['text'] ?? normalized['code'] ?? normalized['replacement'] ?? normalized['replace'];
        if (val !== undefined) {
          if (!cleanExpectedMap['content']) {
            normalized['replacement_content'] = val;
            delete normalized['content'];
            delete normalized['text'];
            delete normalized['code'];
            delete normalized['replacement'];
            delete normalized['replace'];
          }
        }
      }
      if (key === 'target_content' && !normalized['target_content']) {
        const val = normalized['target'] ?? normalized['original'] ?? normalized['old'] ?? normalized['find'] ?? normalized['search'];
        if (val !== undefined) {
          normalized['target_content'] = val;
          delete normalized['target'];
          delete normalized['original'];
          delete normalized['old'];
          delete normalized['find'];
          delete normalized['search'];
        }
      }
    }

    // Post-pass normalizations/fallbacks for built-in tools
    if (name === 'edit_file' || name === 'run_speculative_patch') {
      if (normalized.replacement_content === undefined && normalized.content !== undefined) {
        normalized.replacement_content = normalized.content;
        delete normalized.content;
      }
      if (normalized.target_content === undefined && normalized.replacement_content !== undefined && normalized.file_path) {
        try {
          const resolved = this.resolveWorkspacePath(String(normalized.file_path));
          if (resolved.ok && fs.existsSync(resolved.absolutePath)) {
            const fileContent = fs.readFileSync(resolved.absolutePath, 'utf8');
            normalized.target_content = fileContent;
          } else if (name === 'edit_file') {
            normalized.target_content = '';
          }
        } catch (e) {
          if (name === 'edit_file') {
            normalized.target_content = '';
          }
        }
      }
    } else if (name === 'patch_file_lines') {
      if (normalized.replacement_content === undefined && normalized.content !== undefined) {
        normalized.replacement_content = normalized.content;
        delete normalized.content;
      }
    }

    if (isMcp) {
      const parts = name.split('__');
      if (parts.length >= 3) {
        const serverName = parts[1];
        const toolName = parts.slice(2).join('__');
        const mcpTools = MCPManager.getAllTools();
        const matchedMcp = mcpTools.find(t => t.serverName.toLowerCase() === serverName.toLowerCase() && t.name.toLowerCase() === toolName.toLowerCase());
        if (matchedMcp && matchedMcp.inputSchema && matchedMcp.inputSchema.properties) {
          for (const key of Object.keys(matchedMcp.inputSchema.properties)) {
            const prop = matchedMcp.inputSchema.properties[key];
            if (prop && prop.type) {
              const val = normalized[key];
              if (val !== undefined && typeof val === 'string') {
                if (prop.type === 'number' || prop.type === 'integer') {
                  const num = Number(val);
                  if (!isNaN(num)) {
                    normalized[key] = num;
                  }
                } else if (prop.type === 'boolean') {
                  if (val.toLowerCase() === 'true') normalized[key] = true;
                  if (val.toLowerCase() === 'false') normalized[key] = false;
                }
              }
            }
          }
        }
      }
    }

    return normalized;
  }

  private static repairEditFileFullRewriteArgs(args: Record<string, any>): Record<string, any> {
    if (args.target_content !== undefined || args.replacement_content === undefined || !args.file_path) {
      return args;
    }

    try {
      const resolved = this.resolveWorkspacePath(String(args.file_path));
      if (resolved.ok && fs.existsSync(resolved.absolutePath)) {
        args.target_content = fs.readFileSync(resolved.absolutePath, 'utf8');
      } else {
        // Missing file + missing target means the model is trying to create or
        // overwrite a whole file with edit_file. Let editFile route this to
        // writeFile instead of failing validation and entering a retry loop.
        args.target_content = '';
      }
    } catch {
      args.target_content = '';
    }

    return args;
  }

  private static readonly toolSpecs: Record<string, ToolSchemaSpec> = {
    list_dir: {
      description: 'List files and directories inside the workspace.',
      required: [],
      properties: {
        directory: { type: 'string', description: 'Optional workspace-relative directory. Defaults to the workspace root.' },
      },
    },
    read_file: {
      description: 'Read a text file from the workspace.',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'Workspace-relative or workspace-contained absolute file path.' },
      },
    },
    write_file: {
      description: 'Create or overwrite a file in the workspace.',
      required: ['file_path', 'content'],
      properties: {
        file_path: { type: 'string', description: 'Workspace-relative or workspace-contained absolute file path.' },
        content: { type: 'string', description: 'Complete file content to write. Preserve all intended newlines exactly.' },
      },
    },
    edit_file: {
      description: 'Replace an exact or flexibly matched text block in a workspace file.',
      required: ['file_path', 'target_content', 'replacement_content'],
      properties: {
        file_path: { type: 'string', description: 'Workspace-relative or workspace-contained absolute file path.' },
        target_content: { type: 'string', description: 'Existing text block to replace.' },
        replacement_content: { type: 'string', description: 'Replacement text block.' },
      },
    },
    delete_file: {
      description: 'Delete a file inside the workspace.',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'Workspace-relative or workspace-contained absolute file path.' },
      },
    },
    grep_search: {
      description: 'Search text in workspace files.',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search query text or regular expression.' },
        directory: { type: 'string', description: 'Optional workspace-relative directory to search.' },
      },
    },
    web_search: {
      description: 'Search the web and return summarized search results.',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Web search query.' },
      },
    },
    fetch_webpage: {
      description: 'Fetch readable text from a web page.',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'HTTP or HTTPS URL.' },
      },
    },
    run_command: {
      description: 'Run a shell command in the workspace and capture output.',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Command to run. Do not use cd; pass directory separately.' },
        directory: { type: 'string', description: 'Optional workspace-relative working directory.' },
        timeout_ms: { type: 'string', description: 'Optional timeout in milliseconds.' },
      },
    },
    get_active_editor_context: {
      description: 'Get active editor file path, cursor, and selected text.',
      required: [],
      properties: {},
    },
    get_diagnostics: {
      description: 'Get VS Code diagnostics for the workspace or one file.',
      required: [],
      properties: {
        file_path: { type: 'string', description: 'Optional workspace-relative file path.' },
      },
    },
    preview_html: {
      description: 'Preview raw HTML content or an HTML file in a VS Code webview.',
      required: [],
      properties: {
        file_path: { type: 'string', description: 'Optional workspace-relative HTML file path.' },
        html_content: { type: 'string', description: 'Optional raw HTML content to preview.' },
      },
    },
    verify_edit: {
      description: 'Read a file back from disk and return its current on-disk content plus live diagnostics. Use after every successful write_file or edit_file to verify the change actually landed and did not introduce new errors.',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'Workspace-relative file path to verify.' },
      },
    },
    execute_vscode_command: {
      description: 'Execute a built-in VS Code command.',
      required: ['command_id'],
      properties: {
        command_id: { type: 'string', description: 'VS Code command id.' },
        arguments_json: { type: 'string', description: 'Optional JSON array of command arguments.' },
      },
    },
    find_files: {
      description: 'Find workspace files by glob pattern.',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Glob pattern such as src/**/*.ts.' },
      },
    },
    get_file_outline: {
      description: 'Get document symbols for a source file.',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'Workspace-relative source file path.' },
      },
    },
    git_status: {
      description: 'Return porcelain git status for the workspace repository.',
      required: [],
      properties: {},
    },
    git_diff: {
      description: 'Return the current uncommitted git diff.',
      required: [],
      properties: {},
    },
    web_scrape: {
      description: 'Scrape visible text from a web page using Playwright when available.',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'HTTP or HTTPS URL.' },
        selector: { type: 'string', description: 'Optional CSS selector. Defaults to body.' },
      },
    },
    get_library_docs: {
      description: 'Retrieve developer documentation, API references, and coding templates for programming libraries, frameworks, and SDKs. Only fetches coding/SWE-related content (devdocs.io, public repos, open-source docs, MDN, developer blogs).',
      required: ['library_name'],
      properties: {
        library_name: { type: 'string', description: 'Programming library or framework name such as react, express, tailwindcss, pg, playwright, or supabase.' },
        version: { type: 'string', description: 'Optional version descriptor such as latest, v18, or v4.' },
      },
    },
    search_workspace_symbols: {
      description: 'Search symbols across the workspace.',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Symbol search query.' },
      },
    },
    find_references: {
      description: 'Find references to the symbol at a file location.',
      required: ['file_path', 'line', 'character'],
      properties: {
        file_path: { type: 'string', description: 'Workspace-relative file path.' },
        line: { type: 'string', description: '1-indexed line number.' },
        character: { type: 'string', description: '0-indexed character offset.' },
      },
    },
    find_definitions: {
      description: 'Find definitions for the symbol at a file location.',
      required: ['file_path', 'line', 'character'],
      properties: {
        file_path: { type: 'string', description: 'Workspace-relative file path.' },
        line: { type: 'string', description: '1-indexed line number.' },
        character: { type: 'string', description: '0-indexed character offset.' },
      },
    },
    show_info_message: {
      description: 'Show an informational VS Code toast message.',
      required: ['message'],
      properties: {
        message: { type: 'string', description: 'Message text to display.' },
      },
    },
    get_vscode_extensions: {
      description: 'List installed non-system VS Code extensions.',
      required: [],
      properties: {},
    },
    send_to_terminal: {
      description: 'Send a command to a visible VS Code terminal.',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Command to send to the terminal.' },
        terminal_name: { type: 'string', description: 'Optional terminal tab name.' },
      },
    },
    open_file_to_side: {
      description: 'Open a workspace file in a side editor column.',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'Workspace-relative or workspace-contained absolute file path.' },
      },
    },
    switch_subagent: {
      description: 'Switch the active specialist subagent profile. Use this to change persona based on task progression (e.g. switching to test-writer when ready to write tests, or backend-architect for database work).',
      required: ['subagent_id'],
      properties: {
        subagent_id: {
          type: 'string',
          description: 'The target subagent ID to switch to. Must be one of: frontend-designer, backend-architect, mobile-builder, security-reviewer, test-writer, general-builder.'
        }
      }
    },
    create_webhook_token: {
      description: 'Create a temporary public webhook URL on Webhook.site to test and debug incoming webhooks or HTTP callbacks in real-time.',
      required: [],
      properties: {},
    },
    get_webhook_requests: {
      description: 'Fetch requests sent to a temporary webhook token from Webhook.site.',
      required: ['token_id'],
      properties: {
        token_id: { type: 'string', description: 'The 36-character UUID token ID of the webhook.' },
      },
    },
    // The previously-named "patch_file_lines", "insert_file_lines",
    // "replace_in_files", "run_speculative_patch", and
    // "run_speculative_workspace_patch" tools were collapsed into
    // "edit_file" + "write_file" to stop the model from picking between
    // 7 overlapping file-modification tools. The model only sees
    // read_file, write_file, and edit_file in its native tool schema now.
    // The legacy names are still accepted in `execute()` for backward
    // compatibility (see `LEGACY_TOOL_ALIASES` below) and are routed to
    // the canonical tools.
    get_file_metadata: {
      description: 'Retrieve lightweight metadata (size, line count, modified time) for a file or directory without loading its full content.',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'Workspace-relative or absolute file/directory path.' },
      },
    },
    create_directory: {
      description: 'Create a directory and any parent folders recursively in the workspace.',
      required: ['directory_path'],
      properties: {
        directory_path: { type: 'string', description: 'Workspace-relative directory path to create.' },
      },
    },
    git_diff_file: {
      description: 'Retrieve the current uncommitted git changes for a single file.',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
      },
    },
    insert_file_lines: {
      description: 'Insert content at a specific 1-indexed line number in a workspace file.',
      required: ['file_path', 'line_number', 'content'],
      properties: {
        file_path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
        line_number: { type: 'string', description: '1-indexed line number where content should be inserted.' },
        content: { type: 'string', description: 'The content block to insert.' },
      },
    },
    copy_file: {
      description: 'Copy a file from a source path to a destination path inside the workspace.',
      required: ['source_path', 'destination_path'],
      properties: {
        source_path: { type: 'string', description: 'Workspace-relative or absolute source path.' },
        destination_path: { type: 'string', description: 'Workspace-relative or absolute destination path.' },
      },
    },
    move_file: {
      description: 'Move/rename a file inside the workspace.',
      required: ['source_path', 'destination_path'],
      properties: {
        source_path: { type: 'string', description: 'Workspace-relative or absolute source path.' },
        destination_path: { type: 'string', description: 'Workspace-relative or absolute destination path.' },
      },
    },
    run_speculative_patch: {
      description: 'Speculatively apply a patch to a file and run a validation command to verify it. If verification fails, the change is reverted. Otherwise, it is kept.',
      required: ['file_path', 'target_content', 'replacement_content', 'validation_command'],
      properties: {
        file_path: { type: 'string', description: 'Workspace-relative or absolute file path.' },
        target_content: { type: 'string', description: 'Existing text block to replace.' },
        replacement_content: { type: 'string', description: 'Replacement text block.' },
        validation_command: { type: 'string', description: 'Validation shell command to run (e.g. "npm run compile" or "npm run test:unit").' },
      },
    },
    synthesize_custom_tool: {
      description: 'Synthesize a custom dynamic tool and register it in the workspace dynamic tools registry.',
      required: ['tool_name', 'description', 'required_args_json', 'properties_json', 'code'],
      properties: {
        tool_name: { type: 'string', description: 'Unique name of the custom tool (must use snake_case).' },
        description: { type: 'string', description: 'What this tool does.' },
        required_args_json: { type: 'string', description: 'JSON array of required argument names, e.g. ["query"].' },
        properties_json: { type: 'string', description: 'JSON object describing each argument schema, e.g. {"query":{"type":"string","description":"..."}}.' },
        code: { type: 'string', description: 'JavaScript code implementation. Must export: async function run(args) { ... } returning a string.' },
      },
    },
    capture_page_screenshot: {
      description: 'Render and capture a visual screenshot of a local web page or remote URL using Playwright.',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'The local or remote URL to render.' },
        width: { type: 'string', description: 'Optional viewport width in pixels. Defaults to "1280".' },
        height: { type: 'string', description: 'Optional viewport height in pixels. Defaults to "800".' },
      },
    },
    run_speculative_workspace_patch: {
      description: 'Apply multiple file changes speculatively on a temporary git branch and run a validation command to verify them. If validation fails, changes are discarded and we return to original branch. Otherwise, changes are merged/kept.',
      required: ['patches_json', 'validation_command'],
      properties: {
        patches_json: { type: 'string', description: 'JSON array of patches: [{"file_path":"src/a.ts","target_content":"...","replacement_content":"..."}, ...].' },
        validation_command: { type: 'string', description: 'Validation command (e.g. "npm run compile").' },
      },
    },
    update_dependency_graph: {
      description: 'Parse JavaScript/TypeScript files in the workspace and rebuild the import dependency graph saved to .k-horizon/ast-graph.json.',
      required: [],
      properties: {},
    },
    request_hunk_reviews: {
      description: 'Prompt the developer to review and selectively approve edit hunks for code changes.',
      required: ['diffs_json'],
      properties: {
        diffs_json: { type: 'string', description: 'JSON description of file changes: [{"file_path":"...","hunks":[{"description":"hunk description","target":"...","replacement":"..."}]}]' },
      },
    },
    run_fuzz_test: {
      description: 'Generate and execute an automated fuzz testing script for a specific export to discover runtime crashes.',
      required: ['file_path', 'export_name'],
      properties: {
        file_path: { type: 'string', description: 'Workspace-relative or absolute file path to test.' },
        export_name: { type: 'string', description: 'Name of the function export to fuzz-test.' },
        iterations: { type: 'string', description: 'Optional number of fuzz iterations. Defaults to "100".' },
      },
    },
    db_query: {
      description: 'Execute a read/write SQL query against the configured PostgreSQL/Supabase database.',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'The SQL query string to run.' },
        params_json: { type: 'string', description: 'Optional JSON array of query parameter values, e.g. ["my_value", 123].' }
      }
    },
    db_status: {
      description: 'Check the PostgreSQL/Supabase database connection pool configuration status.',
      required: [],
      properties: {}
    },
    get_learning_rules: {
      description: 'Retrieve the active agent continuous learning and self-correction rules from agent-learning.json.',
      required: [],
      properties: {}
    },
    add_learning_rule: {
      description: 'Manually register a continuous learning rule for the agent to avoid past mistakes.',
      required: ['mistake', 'correction'],
      properties: {
        mistake: { type: 'string', description: 'The mistake description/trigger.' },
        correction: { type: 'string', description: 'The required behavior to follow.' },
        source: { type: 'string', description: 'Optional source of correction. Either "user_correction" or "self_correction".' }
      }
    },
    delete_learning_rule: {
      description: 'Remove a continuous learning rule by its unique ID.',
      required: ['rule_id'],
      properties: {
        rule_id: { type: 'string', description: 'The unique ID of the learning rule to delete.' }
      }
    },
    get_vscode_settings: {
      description: 'Retrieve K-Horizon settings and user configuration values.',
      required: [],
      properties: {
        key: { type: 'string', description: 'Optional specific setting key to fetch (e.g. "chatModel"). If omitted, all settings are returned.' }
      }
    },
    find_learning_rules: {
      description: 'Find matching agent learning rules by a query string. Returns matching learnings as JSON.',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search query to filter learning rules (case-insensitive substring match).' }
      }
    },
    gather_failure_diagnostics: {
      description: 'Gather failure diagnostics for a failing command: run the command verbosely, collect vscode diagnostics and git diff, and return a consolidated report.',
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'The failing shell command to re-run for additional diagnostics (e.g. "npm run compile").' },
        file_path: { type: 'string', description: 'Optional file path suspected to be involved in the failure.' }
      }
    },
    update_vscode_settings: {
      description: 'Update a specific K-Horizon user configuration setting.',
      required: ['key', 'value_json'],
      properties: {
        key: { type: 'string', description: 'The setting key to update (e.g. "coderModel").' },
        value_json: { type: 'string', description: 'The JSON stringified value to set.' }
      }
    },
    toggle_autocomplete: {
      description: 'Enable or disable inline ghost-text code completions.',
      required: ['enabled'],
      properties: {
        enabled: { type: 'string', description: 'Either "true" or "false" to enable/disable completions.' }
      }
    }
  };

  public static abortAllProcesses() {
    for (const child of this.activeProcesses) {
      try {
        child.kill('SIGKILL');
      } catch (e) {
        // Ignore kill errors
      }
    }
    this.activeProcesses.clear();
  }

  public static providerSupportsNativeTools(provider?: string): boolean {
    return ['openai', 'anthropic', 'gemini', 'openrouter', 'custom'].includes((provider || '').toLowerCase());
  }

  private static getDynamicToolsDir(): string {
    const workspaceRoot = getWorkspaceRoot();
    const dir = path.join(workspaceRoot, '.k-horizon', 'dynamic-tools');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private static loadDynamicTools(): Record<string, ToolSchemaSpec> {
    const registry: Record<string, ToolSchemaSpec> = {};
    try {
      const dir = this.getDynamicToolsDir();
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const name = path.basename(file, '.json');
            const content = fs.readFileSync(path.join(dir, file), 'utf8');
            registry[name] = JSON.parse(content);
          }
        }
      }
    } catch (e) {
      // Ignore
    }
    return registry;
  }

  public static getNativeToolDefinitions(format: ToolSchemaFormat): any[] {
    const definitions = Object.entries(this.toolSpecs).map(([name, spec]) =>
      this.formatToolDefinition(name, spec, format)
    );

    const dynamicTools = this.loadDynamicTools();
    for (const [name, spec] of Object.entries(dynamicTools)) {
      definitions.push(this.formatToolDefinition(name, spec, format));
    }

    for (const tool of MCPManager.getAllTools()) {
      const name = `mcp__${tool.serverName}__${tool.name}`;
      const inputSchema = tool.inputSchema || { type: 'object', properties: {}, required: [] };
      if (format === 'anthropic') {
        definitions.push({
          name,
          description: tool.description || `Call MCP tool ${tool.name} on server ${tool.serverName}.`,
          input_schema: inputSchema,
        });
      } else {
        definitions.push({
          type: 'function',
          function: {
            name,
            description: tool.description || `Call MCP tool ${tool.name} on server ${tool.serverName}.`,
            parameters: inputSchema,
          },
        });
      }
    }

    return definitions;
  }

  private static formatToolDefinition(name: string, spec: ToolSchemaSpec, format: ToolSchemaFormat): any {
    const parameters = {
      type: 'object',
      properties: spec.properties,
      required: spec.required,
      additionalProperties: false,
    };

    if (format === 'anthropic') {
      return {
        name,
        description: spec.description,
        input_schema: parameters,
      };
    }

    return {
      type: 'function',
      function: {
        name,
        description: spec.description,
        parameters,
      },
    };
  }

  /**
   * Best-effort recovery for a truncated JSON object string. Streaming
   * `tool_calls` deltas from OpenAI / Gemini / proxies often arrive mid-token
   * (e.g. `{"file_path":"src/`, `a.ts","replacement_content":"x`). When the
   * stream ends before the final `}` we get a `SyntaxError` from `JSON.parse`.
   *
   * Strategy: walk the string and keep a stack of unclosed `{` and `[`. When
   * the parse fails, drop any trailing partial token (string, number, `true`,
   * `false`, `null`, identifier), close every still-open bracket, and try
   * again. Returns the recovered object on success, or `null` if recovery is
   * impossible.
   *
   * This is intentionally conservative — we only recover when the result is a
   * plain object. We never invent fields.
   */
  private static recoverPartialJsonArgs(raw: string): Record<string, any> | null {
    const tryParse = (s: string): any => {
      try { return JSON.parse(s); } catch { return null; }
    };

    // Quick wins: trim trailing comma or colon and close.
    let candidate = raw.replace(/[,\s:]+$/, '');
    // Strip a trailing partial value: "string-no-close, number-no-close, true/false/null, identifier"
    candidate = candidate.replace(
      /(?:"[^"\\]*(?:\\.[^"\\]*)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b|\b[A-Za-z_][A-Za-z0-9_]*\b)\s*$/,
      ''
    );
    // Close open brackets.
    const openCounts: Record<string, number> = { '{': 0, '[': 0 };
    let inString = false;
    let escape = false;
    for (let i = 0; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = false; }
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') openCounts['{']++;
      else if (ch === '}') openCounts['{']--;
      else if (ch === '[') openCounts['[']++;
      else if (ch === ']') openCounts['[']--;
    }
    candidate = candidate + ']'.repeat(Math.max(0, openCounts['['])) + '}'.repeat(Math.max(0, openCounts['{']));
    const parsed = tryParse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
    return null;
  }

  public static normalizeNativeToolCalls(rawToolCalls: any[] | undefined): ToolCall[] {
    if (!rawToolCalls || rawToolCalls.length === 0) return [];

    const normalized: ToolCall[] = [];
    for (const call of rawToolCalls) {
      const name = call?.name || call?.function?.name;
      if (!name || typeof name !== 'string') continue;

      let args = call?.arguments ?? call?.input ?? call?.function?.arguments ?? {};
      if (typeof args === 'string') {
        const trimmed = args.trim();
        if (!trimmed) {
          args = {};
        } else {
          try {
            args = JSON.parse(trimmed);
          } catch {
            // Streaming fragments often arrive mid-JSON (e.g. `{"file_path":"src/`,
            // then `a.ts"}`). Try a recovery pass: trim the last partial
            // value (string, number, identifier) and close any open braces
            // and brackets, then re-parse.
            const recovered = ToolManager.recoverPartialJsonArgs(trimmed);
            if (recovered !== null) {
              args = recovered;
            } else {
              args = {};
            }
          }
        }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        args = {};
      }

      const normalizedArgs = this.normalizeToolArguments(name, args);
      const stringArgs: Record<string, any> = {};
      for (const [key, value] of Object.entries(normalizedArgs)) {
        if (value && typeof value === 'object') {
          stringArgs[key] = value;
        } else {
          stringArgs[key] = typeof value === 'string' ? value : String(value);
        }
      }
      normalized.push({ name, arguments: stringArgs });
    }

    return normalized;
  }

  /**
   * Resolves a raw tool name (potentially hallucinated or with incorrect prefixes)
   * to its canonical form (either a built-in tool or an MCP tool).
   * Returns the canonical tool name, or null if no match is found.
   */
  public static resolveToolName(name: string): string | null {
    if (!name) return null;
    const trimmed = name.trim();
    const knownTools = new Set([
      ...Object.keys(this.requiredToolArgs),
      ...Object.keys(this.toolSpecs || {}),
    ]);
    const dynamicTools = this.loadDynamicTools();

    // 1. Direct match (built-in or dynamic)
    if (knownTools.has(trimmed) || dynamicTools[trimmed]) {
      return trimmed;
    }

    // 2. Direct match with mcp__ prefix
    if (trimmed.startsWith('mcp__')) {
      return trimmed;
    }

    // 3. Cleaned matching logic for MCP tools
    const cleanName = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
    const targetClean = cleanName(trimmed);
    const strippedTarget = targetClean.startsWith('mcp') ? targetClean.substring(3) : targetClean;

    const allMcpTools = MCPManager.getAllTools();
    const matchedMcp = allMcpTools.find(tool => {
      const cleanToolName = cleanName(tool.name);
      const cleanFullToolName = cleanName(tool.serverName + tool.name);
      return cleanToolName === targetClean ||
             cleanFullToolName === targetClean ||
             cleanToolName === strippedTarget ||
             cleanFullToolName === strippedTarget;
    });

    if (matchedMcp) {
      return `mcp__${matchedMcp.serverName}__${matchedMcp.name}`;
    }

    // 4. Fuzzy matching for built-in tools (case-insensitive, alphanumeric-only check)
    for (const kt of knownTools) {
      if (cleanName(kt) === targetClean) {
        return kt;
      }
    }

    return null;
  }

  /**
   * Parses tool calls from generated LLM text.
   *
   * Strategy (newest first, JSON-first):
   *   0. Sanitize: strip any `<think>…</think>` / `<reasoning>…</reasoning>`
   *      / `<reasoning_summary>…</reasoning_summary>` / `:::reasoning … :::`
   *      blocks. Reasoning models regularly mention tool names inside their
   *      chain-of-thought; without this guard the parser would treat an
   *      `<read_file>` referenced in a thought as a real tool call.
   *   1. JSON: extract balanced `{...}` or fenced ```json``` blocks and parse them
   *      as ToolCall objects. Accepts either a single `{"name","arguments"}`
   *      object or an array of such objects, matching our internal contract.
   *   2. XML fallbacks (preserved for compatibility):
   *      a. Standard `<tool_call name="...">...</tool_call>` blocks.
   *      b. Direct tool-name tags `<write_file>...</write_file>`.
   *      c. DeepSeek DSML `<｜DSML｜_tool_call>...</｜DSML｜_tool_call>` wrappers.
   *
   * Returns whichever stage produced the most tool calls. If JSON yields any,
   * it wins; otherwise the XML pipeline runs unchanged.
   */
  public static parseToolCalls(text: string): ToolCall[] {
    const sanitized = ToolManager.stripReasoningFromText(text);
    const jsonCalls = this.parseJsonToolCalls(sanitized);
    if (jsonCalls.length > 0) {
      return jsonCalls;
    }
    return this.parseXmlToolCalls(sanitized);
  }

  /**
   * Strip fenced `<think>` / `<reasoning>` / `<reasoning_summary>` /
   * `:::reasoning` blocks (and unclosed leading variants) from `text`.
   * Exposed as a public static so the agent graph can re-use it for
   * `lastAssistantResponse` cleanup.
   */
  public static stripReasoningFromText(text: string): string {
    if (!text) return '';
    const patterns: RegExp[] = [
      /<think>[\s\S]*?<\/think>/gi,
      /<reasoning>[\s\S]*?<\/reasoning>/gi,
      /<reasoning_summary>[\s\S]*?<\/reasoning_summary>/gi,
      /:::reasoning[\s\S]*?(?:\n:::|:::)/gi,
      /<\|python_tag\|>/gi,
      /<\|tool_call\|>/gi,
    ];
    let cleaned = text;
    for (const p of patterns) cleaned = cleaned.replace(p, '');

    // Replace <tool_call> (without attributes) and its matching </tool_call> if it wraps JSON
    cleaned = cleaned.replace(/<tool_call\s*>\s*([\s\S]*?)\s*<\/tool_call>/gi, '$1');
    cleaned = cleaned.replace(/<tool_call\s*>/gi, ''); // Fallback for unclosed tag

    // Unclosed leading <think> / <reasoning> block: only strip if it never
    // closes anywhere in the text. This is a best-effort defensive pass.
    const m = cleaned.match(/^\s*<(?:think|reasoning)>[\s\S]+$/i);
    if (m && !text.includes('</think>') && !text.includes('</reasoning>')) {
      cleaned = cleaned.replace(m[0], '').trimStart();
    }
    return cleaned;
  }

  /**
   * JSON-first tool-call extractor.
   *
   * Recognized shapes (per the contract documented in AGENTS.md §5):
   *   - Single object:  {"name": "read_file", "arguments": {"file_path": "x.ts"}}
   *   - Array:          [{"name": "edit_file", "arguments": {...}}, ...]
   *   - Fenced JSON in   ```json ... ``` code blocks the LLM occasionally writes.
   *
   * The parser tolerates trailing commas and unquoted properties via a JSON5-
   * style `replace`, but does not import a JSON5 runtime — it only relaxes
   * the two failure modes most often produced by LLMs.
   */
  private static parseJsonToolCalls(text: string): ToolCall[] {
    ToolManager.lastParserError = null;

    // 1a. Pull JSON out of ```json ... ``` fences if present.
    const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    const fencedBlocks: string[] = [];
    let fenceMatch: RegExpExecArray | null;
    while ((fenceMatch = fencedRegex.exec(text)) !== null) {
      const inner = fenceMatch[1].trim();
      if (inner.startsWith('{') || inner.startsWith('[')) {
        fencedBlocks.push(inner);
      }
    }

    // 1b. Walk the text and extract every balanced top-level { ... } or [ ... ].
    const balanced = this.extractBalancedJsonFragments(text);

    const candidates = [...fencedBlocks, ...balanced];
    
    const isKnownTool = (name: string) => this.resolveToolName(name) !== null;

    const scoredCandidates: Array<{
      normalized: ToolCall[];
      score: number;
      isArray: boolean;
    }> = [];

    let syntaxError: string | null = null;
    let hasJsonCandidate = false;

    for (const raw of candidates) {
      const trimmed = raw.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        hasJsonCandidate = true;
      }
      const { parsed, error } = this.tryParseJson(raw);
      if (!parsed) {
        if (error) {
          syntaxError = `JSON syntax error in candidate:\n\`\`\`json\n${raw}\n\`\`\`\nError details: ${error}`;
        }
        continue;
      }
      const normalized = this.normalizeJsonToolCalls(parsed);
      if (normalized.length === 0) {
        syntaxError = `Parsed JSON successfully, but it did not match the expected tool call schema (missing "name" or "arguments" keys):\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
        continue;
      }

      // Calculate score for the candidate
      let score = 0;
      for (const call of normalized) {
        if (isKnownTool(call.name)) {
          score += 10;
        } else {
          score += 1;
        }
      }

      scoredCandidates.push({
        normalized,
        score,
        isArray: Array.isArray(parsed)
      });
    }

    if (scoredCandidates.length === 0) {
      if (hasJsonCandidate && syntaxError) {
        ToolManager.lastParserError = syntaxError;
      }
      return [];
    }

    // Sort by score descending
    scoredCandidates.sort((a, b) => b.score - a.score);

    return scoredCandidates[0].normalized;
  }

  /**
   * Walks `text` and yields every balanced top-level JSON object or array,
   * skipping over characters inside strings (with `\\` escapes).
   */
  private static extractBalancedJsonFragments(text: string): string[] {
    const fragments: string[] = [];
    let depth = 0;
    let opener: '{' | '[' | null = null;
    let start = -1;
    let inString = false;
    let escape = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = false; }
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (depth === 0 && (ch === '{' || ch === '[')) {
        opener = ch;
        start = i;
        depth = 1;
        continue;
      }
      if (depth > 0) {
        if (ch === opener) depth++;
        else if (ch === (opener === '{' ? '}' : ']')) {
          depth--;
          if (depth === 0) {
            fragments.push(text.slice(start, i + 1));
            opener = null;
            start = -1;
          }
        }
      }
    }

    return fragments;
  }

  /**
   * Lenient JSON parse: falls back to stripping trailing commas and
   * wrapping unquoted property names. Returns { parsed, error }.
   */
  private static tryParseJson(raw: string): { parsed: any | null; error?: string } {
    let lastErr: string | undefined;
    const tryParse = (input: string): any | null => {
      try {
        return JSON.parse(input);
      } catch (e: any) {
        lastErr = e.message;
        return null;
      }
    };
    const direct = tryParse(raw);
    if (direct !== null) return { parsed: direct };

    // Strip trailing commas before ] or }
    const noTrailing = raw.replace(/,(\s*[}\]])/g, '$1');
    const relaxed = tryParse(noTrailing);
    if (relaxed !== null) return { parsed: relaxed };

    // Quote unquoted keys: { name: "x", args: {...} }
    const quotedKeys = noTrailing.replace(
      /([\{,\s])([A-Za-z_][A-Za-z0-9_-]*)\s*:/g,
      '$1"$2":',
    );
    const quoted = tryParse(quotedKeys);
    if (quoted !== null) return { parsed: quoted };

    return { parsed: null, error: lastErr };
  }

  /**
   * Coerces a JSON value into one or more ToolCalls. Accepts either the
   * bare `{name, arguments}` shape (returns a 1-element array) or an array
   * of such objects (returns N tool calls, in order, skipping any element
   * that fails validation). Returns an empty array for invalid input.
   *
   * `arguments` are coerced to `Record<string, string>` to match the XML
   * contract and the public `ToolCall` interface downstream `execute()`
   * expects (see ToolCall.arguments). Nested objects are JSON-stringified
   * (lossy but predictable; see AGENTS.md §5 for the canonical shape).
   */
  private static normalizeJsonToolCalls(value: any): ToolCall[] {
    const fromOne = (v: any): ToolCall | null => {
      if (!v || typeof v !== 'object') return null;
      const rawName = typeof v.name === 'string' ? v.name.trim() : '';
      if (!rawName) return null;

      const resolved = this.resolveToolName(rawName);
      if (!resolved) return null;

      let raw = v.arguments ?? v.args ?? v.parameters;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        const rootArgs: Record<string, any> = {};
        for (const [k, val] of Object.entries(v)) {
          if (k !== 'name' && k !== 'arguments' && k !== 'args' && k !== 'parameters') {
            rootArgs[k] = val;
          }
        }
        raw = rootArgs;
      }
      const normalizedArgs = this.normalizeToolArguments(resolved, raw);
      const args: Record<string, any> = {};
      for (const [k, val] of Object.entries(normalizedArgs)) {
        if (val === undefined || val === null) continue;
        args[k] = val;
      }
      return { name: resolved, arguments: args };
    };

    if (Array.isArray(value)) {
      const out: ToolCall[] = [];
      for (const el of value) {
        const tc = fromOne(el);
        if (tc) out.push(tc);
      }
      return out;
    }
    const single = fromOne(value);
    return single ? [single] : [];
  }

  /**
   * Legacy XML parser. Kept as a graceful fallback for older model traces
   * and any provider that still emits XML tool calls. Unchanged behaviour.
   */
  private static parseXmlToolCalls(text: string): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    const processedIndices = new Set<number>();

    // Helper to extract parameters from inner content
    const parseParams = (innerContent: string): Record<string, string> => {
      const args: Record<string, string> = {};
      const tagRegex = /<([a-zA-Z0-9_-]+)>([\s\S]*?)<\/\1>/g;
      let tagMatch;
      while ((tagMatch = tagRegex.exec(innerContent)) !== null) {
        args[tagMatch[1].trim()] = tagMatch[2]; // keep original whitespace
      }
      return args;
    };

    // Build the direct-tag tool name list from every built-in tool schema so
    // the XML fallback stays aligned when new tools are added.
    const knownTools = Array.from(new Set([
      ...Object.keys(this.requiredToolArgs),
      ...Object.keys(this.toolSpecs),
    ]));

    // 1. Try parsing standard <tool_call name="..."> tags
    // We use a flexible closing tag: </tool_call>, </｜DSML｜_tool>, </｜DSML｜_tool_call>, or EOF
    const toolCallRegex = /<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)(?:<\/tool_call>|<\/｜DSML｜_tool>|<\/｜DSML｜_tool_call>|$)/gi;
    let match: RegExpExecArray | null;
    while ((match = toolCallRegex.exec(text)) !== null) {
      const name = match[1].trim();
      const resolved = this.resolveToolName(name);
      if (!resolved) continue;
      const innerContent = match[2];
      const args = parseParams(innerContent);
      const normalizedArgs = this.normalizeToolArguments(resolved, args);
      toolCalls.push({ name: resolved, arguments: normalizedArgs });
      processedIndices.add(match.index);
    }

    // 2. Try parsing direct tool tags (e.g. <write_file> ... </write_file>)
    // This is typical for DeepSeek custom models and native fallback formats
    const toolNamesPattern = `(?:${knownTools.join('|')}|mcp__[a-zA-Z0-9_-]+__[a-zA-Z0-9_-]+)`;
    const directToolRegex = new RegExp(`<(${toolNamesPattern})\\s*>([\\s\\S]*?)(?:<\\/\\1>|<\\/｜DSML｜_tool>|<\\/｜DSML｜_tool_call>|$)`, 'gi');
    
    let directMatch: RegExpExecArray | null;
    while ((directMatch = directToolRegex.exec(text)) !== null) {
      // If this overlap matches a standard <tool_call> block we already processed, skip it
      let alreadyProcessed = false;
      for (const index of processedIndices) {
        if (directMatch.index >= index && directMatch.index < index + 100) {
          alreadyProcessed = true;
          break;
        }
      }
      if (alreadyProcessed) continue;

      const name = directMatch[1].trim();
      const resolved = this.resolveToolName(name);
      if (!resolved) continue;
      const innerContent = directMatch[2];
      const args = parseParams(innerContent);
      const normalizedArgs = this.normalizeToolArguments(resolved, args);
      toolCalls.push({ name: resolved, arguments: normalizedArgs });
    }

    // 3. Fallback: Robust DeepSeek raw text line parser
    if (toolCalls.length === 0) {
      const dsmlRegex = /<(?:｜DSML｜_tool_call|｜Action｜|｜DSML｜_tool)>\s*([\s\S]*?)(?:<\/(?:｜DSML｜_tool_call|｜Action｜|｜DSML｜_tool)>|$)/gi;
      let dsmlMatch: RegExpExecArray | null;
      while ((dsmlMatch = dsmlRegex.exec(text)) !== null) {
        const inner = dsmlMatch[1].trim();
        const lines = inner.split('\n');
        if (lines.length > 1) {
          const filePath = lines[0].trim();
          if (filePath && !filePath.includes(' ') && filePath.includes('.')) {
            const content = lines.slice(1).join('\n').trim();
            toolCalls.push({
              name: 'write_file',
              arguments: {
                file_path: filePath,
                content: content
              }
            });
          }
        }
      }
    }

    return toolCalls;
  }

  /**
   * Resolves a potentially relative path against the active workspace folder.
   */
  public static getAbsolutePath(targetPath: string): string {
    if (!targetPath) return '';
    const cleanPath = targetPath.trim();
    if (path.isAbsolute(cleanPath)) {
      return cleanPath;
    }
    const workspaceRoot = getWorkspaceRoot();
    return path.join(workspaceRoot, cleanPath);
  }

  private static resolveWorkspacePath(targetPath?: string, label = 'file_path'): PathResolution {
    if (!targetPath || !targetPath.trim()) {
      return { ok: false, error: `Error: ${label} argument is missing` };
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      return { ok: false, error: 'Error: No workspace folder open' };
    }

    const absolutePath = path.resolve(this.getAbsolutePath(targetPath));
    const root = path.resolve(workspaceRoot);
    const relative = path.relative(root, absolutePath);
    const isInsideWorkspace = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));

    if (!isInsideWorkspace) {
      return {
        ok: false,
        error: `Error: Refusing to access path outside the workspace: ${targetPath}`,
      };
    }

    return { ok: true, absolutePath };
  }

  private static validateToolCall(name: string, args: Record<string, any>): string | null {
    if (name.startsWith('mcp__')) return null;

    let required = this.requiredToolArgs[name];
    if (!required) {
      const dynamicTools = this.loadDynamicTools();
      if (dynamicTools[name]) {
        required = dynamicTools[name].required;
      }
    }
    if (!required) {
      return `Error: Unknown tool "${name}"`;
    }

    for (const key of required) {
      // Allow content/replacement_content/html_content/target_content to be empty
      // strings – some edits intentionally replace with '' or search for a blank line.
      const allowsEmpty = key === 'content' || key === 'replacement_content' ||
                          key === 'html_content' || key === 'target_content';
      if (
        args[key] === undefined ||
        args[key] === null ||
        (!allowsEmpty && String(args[key]).trim() === '')
      ) {
        const receivedKeys = Object.keys(args).join(', ') || '(none)';
        console.warn(
          `[K-Horizon] validateToolCall: "${name}" missing required arg "${key}".`,
          `Received keys: [${receivedKeys}]`,
          `Received args:`, args
        );
        return `Error: Tool "${name}" requires argument "${key}" (received keys: ${receivedKeys})`;
      }
    }

    return null;
  }

  /**
   * Known-safe base commands for the allowlist advisory.
   * Commands not matching any prefix in this list trigger a soft warning
   * but are NOT blocked — the agent can still proceed.
   */
  private static readonly KNOWN_SAFE_COMMANDS = new Set([
    'npm', 'npx', 'pnpm', 'yarn', 'node',
    'git',
    'tsc', 'webpack', 'vitest', 'jest', 'mocha', 'eslint', 'prettier',
    'pwsh', 'powershell', 'cmd', 'dir', 'echo', 'type', 'cat', 'findstr',
    'ls', 'pwd', 'mkdir', 'copy', 'move', 'ren', 'attrib',
    'node-gyp', 'ng', 'nx', 'turbo',
    'python', 'python3', 'pip', 'pip3',
    'dotnet', 'cargo', 'go', 'rustc', 'gcc', 'clang', 'cmake',
    'code', 'code-insiders',
    '7z', 'tar', 'unzip', 'gzip',
  ]);

  private static isDangerousCommand(command: string): string | null {
    const normalized = command.replace(/\s+/g, ' ').trim().toLowerCase();
    const blockedPatterns = [
      // Destructive filesystem
      /\brm\s+(-[a-z]*r[a-z]*f|-rf|-fr)\s+(\/|\*|~|\.\.)/,
      /\bremove-item\b.*\b-recurse\b.*\b-force\b/i,
      /\brmdir\s+\/s\b/i,
      /\bdel\s+\/[a-z]*s[a-z]*\b/i,
      /\bformat\s+[a-z]:/i,
      /\bmkfs\b/,
      // Destructive git
      /\bgit\s+reset\s+--hard\b/,
      /\bgit\s+clean\s+-[a-z]*f[a-z]*d/,
      // System-level
      /\bshutdown\b/,
      /\breboot\b/,
      /\bhalt\b/,
      /\bpoweroff\b/,
      // Registry (Windows)
      /\breg\s+(add|delete)\b/i,
      /\bregedit\b/i,
      // Network exfiltration / download
      /\bcurl\s+(-o|--output|-O|--remote-name)\s+/,
      /\bwget\s+(-O|--output-document|-P|--directory-prefix)\s+/,
      /\binvoke-webrequest\b.*\b-outfile\b/i,
      /\biwr\b.*\b-outfile\b/i,
      // Arbitrary code execution
      /\binvoke-expression\b/i,
      /\biex\b/i,
      // Disk / partition manipulation
      /\bdiskpart\b/i,
      /\bfdisk\b/i,
      /\bmount\s+/i,
      /\bumount\b/i,
      // Environment / credential exfil
      /\bget-childitem\s+env:/i,
      /\bprintenv\s+/i,
    ];

    if (blockedPatterns.some((pattern) => pattern.test(normalized))) {
      return 'Error: Refusing to run a high-risk destructive command. This action has been blocked for safety. Ask the user for an explicit manual action instead.';
    }

    return null;
  }

  /**
   * Soft advisory: warns if the base command is not in the known-safe list,
   * but does NOT block execution. The agent can still proceed.
   */
  private static warnIfUnusualCommand(command: string): string | null {
    const firstToken = command.trim().split(/\s+/)[0]?.toLowerCase();
    if (!firstToken) return null;
    // Strip any path prefix (e.g. "./node_modules/.bin/eslint" → "eslint")
    const baseCommand = path.basename(firstToken);
    if (this.KNOWN_SAFE_COMMANDS.has(baseCommand)) return null;
    // Allow relative paths and absolute paths to known tools
    if (baseCommand.endsWith('.exe') || baseCommand.endsWith('.bat') || baseCommand.endsWith('.ps1')) {
      return null;
    }
    return `[SECURITY ADVISORY] The command "${command}" starts with "${baseCommand}" which is not in the known-safe command list. Verify this is intentional.`;
  }

  private static validatePackageInstallCommand(command: string): string | null {
    const npmInstallMatch = command.match(/^\s*(?:npm\s+(?:install|i|in|ins|inst|insta|instal)|yarn\s+add|pnpm\s+add)\s+(.+)$/i);
    if (npmInstallMatch) {
      const targets = npmInstallMatch[1].split(/\s+/);
      for (const target of targets) {
        if (target.startsWith('-')) continue;
        if (target.startsWith('.') || target.startsWith('/') || target.startsWith('\\') || /^[A-Za-z]:[\\\/]/.test(target) || (!target.startsWith('@') && (target.includes('/') || target.includes('\\')))) {
          return `Error: Cannot install a local path or relative directory "${target}" as an npm package. If this is a local component or module, verify that the file exists and update the import statements in your code instead.`;
        }
      }
    }
    
    const pipInstallMatch = command.match(/^\s*(?:pip\s+install|pip3\s+install)\s+(.+)$/i);
    if (pipInstallMatch) {
      const targets = pipInstallMatch[1].split(/\s+/);
      for (const target of targets) {
        if (target.startsWith('-')) continue;
        if (target.startsWith('.') || target.startsWith('/') || target.startsWith('\\') || /^[A-Za-z]:[\\\/]/.test(target) || target.includes('/') || target.includes('\\')) {
          return `Error: Cannot install a local path or relative directory "${target}" as a python package.`;
        }
      }
    }
    return null;
  }

  public static commandExists(cmd: string): boolean {
    try {
      const checkCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`;
      execSync(checkCmd, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Executes a tool by name and arguments.
   */
  public static async execute(name: string, rawArgs: Record<string, any>): Promise<string> {
    try {
      let resolvedName = name;
      let isMcp = resolvedName.startsWith('mcp__');

      if (!isMcp) {
        const knownTools = new Set([
          ...Object.keys(this.requiredToolArgs),
          ...Object.keys(this.toolSpecs || {}),
        ]);
        const dynamicTools = this.loadDynamicTools();
        const isBuiltinOrDynamic = knownTools.has(resolvedName) || !!dynamicTools[resolvedName];

        if (!isBuiltinOrDynamic) {
          // Look up in MCPManager to see if it is a tool exposed by an MCP server
          const cleanName = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
          const targetClean = cleanName(resolvedName);
          const strippedTarget = targetClean.startsWith('mcp') ? targetClean.substring(3) : targetClean;

          const allMcpTools = MCPManager.getAllTools();
          const matchedMcp = allMcpTools.find(tool => {
            const cleanToolName = cleanName(tool.name);
            const cleanFullToolName = cleanName(tool.serverName + tool.name);
            return cleanToolName === targetClean ||
                   cleanFullToolName === targetClean ||
                   cleanToolName === strippedTarget ||
                   cleanFullToolName === strippedTarget;
          });
          if (matchedMcp) {
            resolvedName = `mcp__${matchedMcp.serverName}__${matchedMcp.name}`;
            isMcp = true;
          }
        }
      }

      // Diagnostic logging for file-editing tools to help trace argument name issues.
      if (resolvedName === 'edit_file' || resolvedName === 'patch_file_lines' || resolvedName === 'run_speculative_patch') {
        console.log(`[K-Horizon] execute("${resolvedName}") raw keys:`, Object.keys(rawArgs));
      }

      const normalizedArgs = this.normalizeToolArguments(resolvedName, rawArgs);

      if (resolvedName === 'edit_file' || resolvedName === 'patch_file_lines' || resolvedName === 'run_speculative_patch') {
        console.log(`[K-Horizon] execute("${resolvedName}") normalized keys:`, Object.keys(normalizedArgs));
      }

      const args: Record<string, any> = {};
      for (const key of Object.keys(normalizedArgs)) {
        const val = normalizedArgs[key];
        if (val === undefined || val === null) continue;
        if (isMcp) {
          args[key] = val;
        } else {
          args[key] = typeof val === 'string' ? val : (typeof val === 'object' ? JSON.stringify(val) : String(val));
        }
      }

      if (resolvedName === 'edit_file') {
        this.repairEditFileFullRewriteArgs(args);
      }

      const validationError = this.validateToolCall(resolvedName, args);
      if (validationError) return validationError;

      if (isMcp) {
        const parts = resolvedName.split('__');
        if (parts.length >= 3) {
          const serverName = parts[1];
          const toolName = parts.slice(2).join('__');
          const canonicalServerName = MCPManager.getCanonicalServerName(serverName);

          // Documentation MCP guardrail: only allow coding/dev-related queries
          // Applies to Context7 — library documentation server
          const DOC_SERVERS = ['Context7'];
          if (DOC_SERVERS.some(ds => ds.toLowerCase() === serverName.toLowerCase())) {
            const queryVal = String(args.query || args.libraryName || '').toLowerCase();
            const DEV_KEYWORDS = [
              'api', 'sdk', 'library', 'framework', 'docs', 'documentation',
              'install', 'config', 'setup', 'build', 'deploy', 'test',
              'code', 'coding', 'programming', 'developer', 'dev',
              'function', 'method', 'class', 'module', 'package', 'import',
              'npm', 'pip', 'yarn', 'cargo', 'gem', 'nuget', 'maven',
              'react', 'vue', 'angular', 'next', 'express', 'django',
              'flask', 'spring', 'fastify', 'nest', 'svelte', 'remix',
              'typescript', 'javascript', 'python', 'rust', 'go', 'java',
              'css', 'html', 'sql', 'graphql', 'rest', 'grpc', 'websocket',
              'docker', 'kubernetes', 'terraform', 'aws', 'gcp', 'azure',
              'git', 'ci', 'cd', 'pipeline', 'lint', 'format', 'debug',
              'database', 'postgres', 'mysql', 'redis', 'mongo', 'prisma',
              'auth', 'oauth', 'jwt', 'session', 'middleware', 'route',
              'component', 'hook', 'state', 'context', 'render', 'ssr',
              'cli', 'terminal', 'shell', 'script', 'webpack', 'vite',
              'tailwind', 'bootstrap', 'material', 'chakra', 'shadcn',
              'node', 'deno', 'bun', 'runtime', 'compiler', 'bundler',
              'open-source', 'opensource', 'github', 'gitlab', 'repo',
              'devdocs', 'mdn', 'stackoverflow', 'migration', 'schema',
              'endpoint', 'server', 'client', 'frontend', 'backend',
              'fullstack', 'microservice', 'monorepo', 'plugin', 'extension',
              'type', 'interface', 'generic', 'async', 'promise', 'callback',
              'error', 'exception', 'log', 'monitor', 'performance', 'cache',
              'orm', 'query', 'crud', 'rest', 'http', 'fetch', 'axios',
              'supabase', 'firebase', 'vercel', 'netlify', 'cloudflare',
              'stripe', 'twilio', 'sendgrid', 'sentry', 'datadog',
              'playwright', 'cypress', 'jest', 'vitest', 'mocha', 'pytest',
            ];
            const isDevRelated = !queryVal || DEV_KEYWORDS.some(kw => queryVal.includes(kw));
            if (!isDevRelated) {
              return `[DocServer Guard] Query rejected: ${serverName} is restricted to coding, SWE, and developer documentation topics only. ` +
                `Please rephrase your query to focus on a programming library, framework, API, SDK, or developer tool.`;
            }
          }

          return await MCPManager.callMcpTool(canonicalServerName, toolName, args);
        }
      }

      switch (resolvedName) {
        case 'list_dir':
          return await this.listDir(args.directory);
        case 'read_file':
          return await this.readFile(args.file_path);
        case 'write_file':
          return await this.writeFile(args.file_path, args.content);
        case 'edit_file':
          return await this.editFile(args.file_path, args.target_content, args.replacement_content);
        case 'delete_file':
          return await this.deleteFile(args.file_path);
        case 'grep_search':
          return await this.grepSearch(args.query, args.directory);
        case 'web_search':
          return await this.webSearch(args.query);
        case 'fetch_webpage':
          return await this.fetchWebpage(args.url);
        case 'run_command':
          return await this.runCommand(
            args.command,
            args.directory,
            args.timeout_ms ? parseInt(args.timeout_ms) : undefined
          );
        case 'web_scrape':
          return await this.webScrape(args.url, args.selector);
        case 'get_library_docs':
          return await this.getLibraryDocs(args.library_name, args.version);
        case 'get_diagnostics':
          return await this.getDiagnostics(args.file_path);
        case 'get_active_editor_context':
          return await this.getActiveEditorContext();
        case 'search_workspace_symbols':
          return await this.searchWorkspaceSymbols(args.query);
        case 'find_references':
          return await this.findReferences(args.file_path, args.line, args.character);
        case 'find_definitions':
          return await this.findDefinitions(args.file_path, args.line, args.character);
        case 'show_info_message':
          return await this.showInfoMessage(args.message);
        case 'get_vscode_extensions':
          return await this.getVSCodeExtensions();
        case 'send_to_terminal':
          return await this.sendToTerminal(args.command, args.terminal_name);
        case 'open_file_to_side':
          return await this.openFileToSide(args.file_path);
        case 'preview_html':
          return await this.previewHtml(args.file_path, args.html_content);
        case 'verify_edit':
          return await this.verifyEdit(args.file_path);
        case 'execute_vscode_command':
          return await this.executeVSCodeCommand(args.command_id, args.arguments_json);
        case 'find_files':
          return await this.findFiles(args.pattern);
        case 'get_file_outline':
          return await this.getFileOutline(args.file_path);
        case 'git_status':
          return await this.gitStatus();
        case 'git_diff':
          return await this.gitDiff();
        case 'switch_subagent':
          return `Success: Switched active subagent profile to ${args.subagent_id}. The change will take effect on the next turn.`;
        case 'create_webhook_token':
          return await this.createWebhookToken();
        case 'get_webhook_requests':
          return await this.getWebhookRequests(args.token_id);
        case 'patch_file_lines':
          return await this.patchFileLines(args.file_path, args.start_line, args.end_line, args.replacement_content);
        case 'insert_file_lines':
          return await this.insertFileLines(args.file_path, args.line_number, args.content);
        case 'copy_file':
          return await this.copyFile(args.source_path, args.destination_path);
        case 'move_file':
          return await this.moveFile(args.source_path, args.destination_path);
        case 'run_speculative_patch':
          return await this.runSpeculativePatch(
            args.file_path,
            args.target_content,
            args.replacement_content,
            args.validation_command
          );
        case 'synthesize_custom_tool':
          return await this.synthesizeCustomTool(
            args.tool_name,
            args.description,
            args.required_args_json,
            args.properties_json,
            args.code
          );
        case 'capture_page_screenshot':
          return await this.capturePageScreenshot(
            args.url,
            args.width,
            args.height
          );
        case 'run_speculative_workspace_patch':
          return await this.runSpeculativeWorkspacePatch(
            args.patches_json,
            args.validation_command
          );
        case 'update_dependency_graph':
          return await this.updateDependencyGraph();
        case 'trace_symbol_dependency':
          return await this.traceSymbolDependency(args.symbol_name, args.depth ? parseInt(args.depth) : undefined);
        case 'replace_in_files':
          return await this.replaceInFiles(args.query, args.replacement, args.includes);
        case 'get_file_metadata':
          return this.getFileMetadata(args.file_path);
        case 'create_directory':
          return this.createDirectory(args.directory_path);
        case 'git_diff_file':
          return await this.gitDiffFile(args.file_path);
        case 'request_hunk_reviews':
          return await this.requestHunkReviews(
            args.diffs_json
          );
        case 'run_fuzz_test':
          return await this.runFuzzTest(
            args.file_path,
            args.export_name,
            args.iterations
          );
        case 'db_query':
          return await this.dbQuery(args.query, args.params_json);
        case 'db_status':
          return await this.dbStatus();
        case 'get_learning_rules':
          return await this.getLearningRules();
        case 'find_learning_rules':
          return await this.findLearningRules(args.query);
        case 'gather_failure_diagnostics':
          return await this.gatherFailureDiagnostics(args.command, args.file_path);
        case 'add_learning_rule':
          return await this.addLearningRule(args.mistake, args.correction, args.source);
        case 'delete_learning_rule':
          return await this.deleteLearningRule(args.rule_id);
        case 'get_vscode_settings':
          return await this.getVscodeSettings(args.key);
        case 'update_vscode_settings':
          return await this.updateVscodeSettings(args.key, args.value_json);
        case 'toggle_autocomplete':
          return await this.toggleAutocomplete(args.enabled);
        default:
          const dynamicTools = this.loadDynamicTools();
          if (dynamicTools[resolvedName]) {
            return await this.executeDynamicTool(resolvedName, args);
          }
          return `Error: Unknown tool "${resolvedName}"`;
      }
    } catch (e: any) {
      return `Error executing tool "${name}": ${e.message}`;
    }
  }

  // --- Tool Implementations ---

  private static async listDir(directory?: string): Promise<string> {
    const resolved = this.resolveWorkspacePath(directory || '.', 'directory');
    if (!resolved.ok) return resolved.error;
    const targetDir = resolved.absolutePath;
    if (!fs.existsSync(targetDir)) {
      return `Directory does not exist: ${directory}`;
    }
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      return `Path is not a directory: ${directory}`;
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => `[Dir]  ${e.name}`);
    const files = entries.filter(e => e.isFile()).map(e => `[File] ${e.name} (${fs.statSync(path.join(targetDir, e.name)).size} bytes)`);

    return `Contents of directory "${vscode.workspace.asRelativePath(targetDir)}":\n` + 
      [...dirs, ...files].join('\n') || '(directory is empty)';
  }

  private static async readFile(filePath?: string): Promise<string> {
    const resolved = this.resolveWorkspacePath(filePath);
    if (!resolved.ok) return resolved.error;
    const targetFile = resolved.absolutePath;
    if (!fs.existsSync(targetFile)) {
      return `Error: File not found: ${filePath}`;
    }
    const stat = fs.statSync(targetFile);
    if (stat.isDirectory()) {
      return `Error: Path is a directory, use list_dir: ${filePath}`;
    }
    const content = fs.readFileSync(targetFile, 'utf8');
    return content;
  }

  private static async writeFile(filePath?: string, content?: string): Promise<string> {
    const resolved = this.resolveWorkspacePath(filePath);
    if (!resolved.ok) return resolved.error;
    const targetFile = resolved.absolutePath;

    // Syntax validation check
    const syntaxCheck = this.validateSyntax(targetFile, content || '');
    if (!syntaxCheck.ok) {
      return `Error: Syntax verification failed. Your proposed changes introduce syntax errors:\n${syntaxCheck.error}`;
    }

    const config = vscode.workspace.getConfiguration('k-horizon');
    const enablePreemptiveDryRuns = config.get<boolean>('enablePreemptiveDryRuns', false);

    const parentDir = path.dirname(targetFile);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const fileExists = fs.existsSync(targetFile);
    const originalContent = fileExists ? fs.readFileSync(targetFile, 'utf8') : null;

    fs.writeFileSync(targetFile, content || '', 'utf8');

    if (enablePreemptiveDryRuns) {
      const workspaceRoot = getWorkspaceRoot();
      if (workspaceRoot) {
        const verifyCmds = detectVerificationCommands(workspaceRoot);
        if (verifyCmds.compileCommand) {
          try {
            const validationOutput = await this.runCommand(verifyCmds.compileCommand);
            const failedFlagMatch = validationOutput.match(/\[FAILED:\s*(true|false)\]/);
            const failed = failedFlagMatch 
              ? failedFlagMatch[1] === 'true' 
              : (validationOutput.includes('[COMMAND FAILED]') || validationOutput.includes('[COMMAND TIMEOUT]'));

            if (failed) {
              if (originalContent !== null) {
                fs.writeFileSync(targetFile, originalContent, 'utf8');
              } else {
                fs.unlinkSync(targetFile);
              }
              return `Error: Pre-emptive Dry Run failed. The change introduces build/compilation errors:\n${validationOutput}\nWorkspace changes rolled back.`;
            }
          } catch (e: any) {
            if (originalContent !== null) {
              fs.writeFileSync(targetFile, originalContent, 'utf8');
            } else {
              fs.unlinkSync(targetFile);
            }
            return `Error running compilation validation, workspace changes rolled back: ${e.message}`;
          }
        }
      }
    }

    return `Success: Wrote to file: ${vscode.workspace.asRelativePath(targetFile)}`;
  }

  private static async editFile(filePath?: string, targetContent?: string, replacementContent?: string): Promise<string> {
    if (targetContent === undefined || replacementContent === undefined) {
      return 'Error: target_content and replacement_content arguments are required';
    }

    const resolved = this.resolveWorkspacePath(filePath);
    if (!resolved.ok) return resolved.error;
    const targetFile = resolved.absolutePath;
    if (!fs.existsSync(targetFile)) {
      if (targetContent === '') {
        return await this.writeFile(filePath, replacementContent);
      }
      return `Error: File not found: ${filePath}`;
    }

    const content = fs.readFileSync(targetFile, 'utf8');
    const cleanTarget = targetContent;
    const cleanReplacement = replacementContent;
    const editResult = this.applyFlexibleReplacement(content, cleanTarget, cleanReplacement);

    if (!editResult) {
      const targetPreview = cleanTarget.split(/\r?\n/).slice(0, 8).join('\n');

      // Build a self-describing failure message that includes the actual file content
      // around the most likely match location. The agent can use this to see exactly
      // what differs between its target and the real file content.
      const fileContent = content;
      const targetFirstLine = cleanTarget.split(/\r?\n/).find(l => l.trim().length > 0) || '';
      let contextSnippet = '(no plausible match found in file)';

      if (targetFirstLine.trim().length > 0) {
        const fileLines = fileContent.split(/\r?\n/);
        const targetTrimmed = targetFirstLine.trim();

        // Find the closest line in the file by simple includes check, then by prefix.
        let bestIdx = fileLines.findIndex(l => l.includes(targetTrimmed) || targetTrimmed.includes(l.trim()));
        if (bestIdx === -1) {
          // Fall back: prefix match
          const targetPrefix = targetTrimmed.slice(0, Math.min(40, targetTrimmed.length));
          bestIdx = fileLines.findIndex(l => l.trimStart().startsWith(targetPrefix));
        }
        if (bestIdx !== -1) {
          const start = Math.max(0, bestIdx - 2);
          const end = Math.min(fileLines.length, bestIdx + Math.max(8, cleanTarget.split(/\r?\n/).length) + 2);
          const numbered = fileLines
            .slice(start, end)
            .map((l, i) => `${start + i + 1}: ${l}`)
            .join('\n');
          contextSnippet = numbered;
        }
      }

      return `Error: Target content to replace was not found in file. Tried exact, normalized-newline, trimmed, and line-whitespace tolerant matching.\nFile: ${vscode.workspace.asRelativePath(targetFile)}\nTarget preview (first 8 lines you sent):\n${targetPreview}\n\nActual file content near the closest matching line:\n\`\`\`\n${contextSnippet}\n\`\`\`\n\nFix hint: compare the actual file content above to your target preview. The most common causes are: (1) leading/trailing whitespace differs, (2) you used smart quotes or different line endings, (3) you assumed line numbers that shifted after a previous edit. Re-read the file with \`<tool_call name="read_file"><file_path>${vscode.workspace.asRelativePath(targetFile)}</file_path>\` and copy the exact text you want to replace.`;
    }

    const updated = editResult.content;

    // Syntax validation check
    const syntaxCheck = this.validateSyntax(targetFile, updated);
    if (!syntaxCheck.ok) {
      return `Error: Syntax verification failed. Your proposed changes introduce syntax errors:\n${syntaxCheck.error}`;
    }

    const config = vscode.workspace.getConfiguration('k-horizon');
    const enablePreemptiveDryRuns = config.get<boolean>('enablePreemptiveDryRuns', false);

    fs.writeFileSync(targetFile, updated, 'utf8');

    if (enablePreemptiveDryRuns) {
      const workspaceRoot = getWorkspaceRoot();
      if (workspaceRoot) {
        const verifyCmds = detectVerificationCommands(workspaceRoot);
        if (verifyCmds.compileCommand) {
          try {
            const validationOutput = await this.runCommand(verifyCmds.compileCommand);
            const failedFlagMatch = validationOutput.match(/\[FAILED:\s*(true|false)\]/);
            const failed = failedFlagMatch 
              ? failedFlagMatch[1] === 'true' 
              : (validationOutput.includes('[COMMAND FAILED]') || validationOutput.includes('[COMMAND TIMEOUT]'));

            if (failed) {
              fs.writeFileSync(targetFile, content, 'utf8');
              return `Error: Pre-emptive Dry Run failed. The change introduces build/compilation errors:\n${validationOutput}\nWorkspace changes rolled back.`;
            }
          } catch (e: any) {
            fs.writeFileSync(targetFile, content, 'utf8');
            return `Error running compilation validation, workspace changes rolled back: ${e.message}`;
          }
        }
      }
    }

    // Create a temp file to hold original content for native VS Code diffing
    const tempDir = os.tmpdir();
    const randomId = Math.random().toString(36).substring(7);
    const fileName = path.basename(targetFile);
    const tempOriginalPath = path.join(tempDir, `k_horizon_sidebar_orig_${randomId}_${fileName}`);
    fs.writeFileSync(tempOriginalPath, content, 'utf8');

    const diffLines: string[] = [];
    const originalLines = cleanTarget.split('\n');
    const newLines = cleanReplacement.split('\n');
    originalLines.forEach(l => diffLines.push(`- ${l}`));
    newLines.forEach(l => diffLines.push(`+ ${l}`));

    return `Success: Edited file: ${vscode.workspace.asRelativePath(targetFile)} (${editResult.strategy} match)\n\n[DIFF]\n${diffLines.join('\n')}\n\n[DIFF_PATHS]\n${tempOriginalPath}|${targetFile}`;
  }

  public static applyPlaceholderReplacement(
    originalContent: string,
    targetContent: string,
    replacementContent: string
  ): { content: string; strategy: string } | null {
    const lines = targetContent.split(/\r?\n/);
    const placeholderRegex = /^\s*(?:\/\/|\/\*|#|--|\*)*\s*\.\.\.\s*(?:\*\/)?\s*$/;
    
    const placeholderIndices: number[] = [];
    lines.forEach((line, idx) => {
      if (placeholderRegex.test(line)) {
        placeholderIndices.push(idx);
      }
    });

    if (placeholderIndices.length === 0) {
      return null;
    }

    // Split targetContent into non-empty segments separated by placeholders
    const segments: string[][] = [];
    let currentSegment: string[] = [];
    lines.forEach((line) => {
      if (placeholderRegex.test(line)) {
        if (currentSegment.length > 0) {
          segments.push(currentSegment);
          currentSegment = [];
        }
      } else {
        currentSegment.push(line);
      }
    });
    if (currentSegment.length > 0) {
      segments.push(currentSegment);
    }

    // We need at least a prefix and a suffix segment to do a span replacement
    if (segments.length < 2) {
      return null;
    }

    const firstSegment = segments[0].join('\n');
    const lastSegment = segments[segments.length - 1].join('\n');

    // Find the positions of the first and last segments in the original content
    const normalizedOriginal = originalContent.replace(/\r\n/g, '\n');
    const normalizedFirst = firstSegment.replace(/\r\n/g, '\n');
    const normalizedLast = lastSegment.replace(/\r\n/g, '\n');

    const firstIndex = this.findSegmentMatchIndex(normalizedOriginal, normalizedFirst);
    if (firstIndex === -1) return null;

    const lastIndex = this.findSegmentMatchIndex(normalizedOriginal, normalizedLast, firstIndex + normalizedFirst.length);
    if (lastIndex === -1) return null;

    const eol = originalContent.includes('\r\n') ? '\r\n' : '\n';
    const next = normalizedOriginal.slice(0, firstIndex)
      + replacementContent.replace(/\r\n/g, '\n')
      + normalizedOriginal.slice(lastIndex + normalizedLast.length);

    return {
      content: eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next,
      strategy: 'placeholder-span-replacement'
    };
  }

  private static findSegmentMatchIndex(content: string, segment: string, startFrom = 0): number {
    const idx = content.indexOf(segment, startFrom);
    if (idx !== -1) return idx;

    // Fallback: Line-whitespace-tolerant match
    const contentLines = content.split('\n');
    const segmentLines = segment.split('\n');
    const normalizeLine = (line: string) => line.replace(/[ \t]+$/g, '').trimStart();
    const normalizedSegmentLines = segmentLines.map(normalizeLine);

    // Find startFrom line index
    let startLineIdx = 0;
    let charCount = 0;
    for (let i = 0; i < contentLines.length; i++) {
      if (charCount >= startFrom) {
        startLineIdx = i;
        break;
      }
      charCount += contentLines[i].length + 1; // +1 for newline
    }

    for (let start = startLineIdx; start <= contentLines.length - segmentLines.length; start++) {
      let matches = true;
      for (let offset = 0; offset < segmentLines.length; offset++) {
        if (normalizeLine(contentLines[start + offset]) !== normalizedSegmentLines[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        // Calculate char index of this line match
        let matchCharIdx = 0;
        for (let i = 0; i < start; i++) {
          matchCharIdx += contentLines[i].length + 1;
        }
        return matchCharIdx;
      }
    }

    return -1;
  }

  public static applyFlexibleReplacement(
    originalContent: string,
    targetContent: string,
    replacementContent: string
  ): { content: string; strategy: string } | null {
    if (targetContent === '') {
      return null;
    }

    const placeholderRes = this.applyPlaceholderReplacement(originalContent, targetContent, replacementContent);
    if (placeholderRes) {
      return placeholderRes;
    }

    // Support SEARCH/REPLACE blocks format in targetContent or replacementContent
    if (targetContent.includes('<<<<<<< SEARCH') || replacementContent.includes('<<<<<<< SEARCH')) {
      const blockContent = targetContent.includes('<<<<<<< SEARCH') ? targetContent : replacementContent;
      const regex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
      let currentContent = originalContent;
      let matchedCount = 0;
      let match;
      
      regex.lastIndex = 0;
      while ((match = regex.exec(blockContent)) !== null) {
        const searchBlock = match[1];
        const replaceBlock = match[2];
        const res = this.applyFlexibleReplacement(currentContent, searchBlock, replaceBlock);
        if (res) {
          currentContent = res.content;
          matchedCount++;
        }
      }
      if (matchedCount > 0) {
        return {
          content: currentContent,
          strategy: `search-replace-blocks (${matchedCount} blocks matched)`
        };
      }
    }

    if (originalContent.includes(targetContent) && !this.hasLineWhitespaceDrift(originalContent, targetContent)) {
      return {
        content: originalContent.replace(targetContent, replacementContent),
        strategy: 'exact'
      };
    }

    const eol = originalContent.includes('\r\n') ? '\r\n' : '\n';
    const normalizedOriginal = originalContent.replace(/\r\n/g, '\n');
    const normalizedTarget = targetContent.replace(/\r\n/g, '\n');
    const normalizedReplacement = replacementContent.replace(/\r\n/g, '\n');

    const normalizedIndex = normalizedOriginal.indexOf(normalizedTarget);
    if (normalizedIndex !== -1 && !this.hasLineWhitespaceDrift(normalizedOriginal, normalizedTarget)) {
      const next = normalizedOriginal.slice(0, normalizedIndex)
        + normalizedReplacement
        + normalizedOriginal.slice(normalizedIndex + normalizedTarget.length);
      return {
        content: eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next,
        strategy: 'newline-normalized'
      };
    }

    const trimmedTarget = this.trimOuterBlankLines(normalizedTarget);
    const trimmedReplacement = this.trimOuterBlankLines(normalizedReplacement);
    const trimmedIndex = normalizedOriginal.indexOf(trimmedTarget);
    if (trimmedTarget && trimmedIndex !== -1 && !this.hasLineWhitespaceDrift(normalizedOriginal, trimmedTarget)) {
      const next = normalizedOriginal.slice(0, trimmedIndex)
        + trimmedReplacement
        + normalizedOriginal.slice(trimmedIndex + trimmedTarget.length);
      return {
        content: eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next,
        strategy: 'outer-blank-trimmed'
      };
    }

    const lineMatch = this.replaceByLineMatch(normalizedOriginal, trimmedTarget, trimmedReplacement);
    if (lineMatch) {
      return {
        content: eol === '\r\n' ? lineMatch.content.replace(/\n/g, '\r\n') : lineMatch.content,
        strategy: 'line-whitespace-tolerant-trimmed'
      };
    }

    const fuzzyMatch = this.replaceByFuzzyWindowMatch(normalizedOriginal, trimmedTarget, trimmedReplacement);
    if (fuzzyMatch) {
      return {
        content: eol === '\r\n' ? fuzzyMatch.content.replace(/\n/g, '\r\n') : fuzzyMatch.content,
        strategy: `fuzzy-line-window (similarity: ${fuzzyMatch.similarity.toFixed(2)})`
      };
    }

    return null;
  }

  private static replaceByFuzzyWindowMatch(
    normalizedOriginal: string,
    trimmedTarget: string,
    trimmedReplacement: string
  ): { content: string; similarity: number } | null {
    const originalLines = normalizedOriginal.split('\n');
    const targetLines = trimmedTarget.split('\n');

    const nonTrivialTargetLines = targetLines.filter(l => l.trim().length >= 3);
    if (nonTrivialTargetLines.length === 0) {
      return null;
    }

    const getLineSimilarity = (lineA: string, lineB: string): number => {
      const cleanA = lineA.trim().replace(/\s+/g, ' ');
      const cleanB = lineB.trim().replace(/\s+/g, ' ');
      if (cleanA === cleanB) return 1.0;
      if (!cleanA || !cleanB) return 0.0;
      const wordsA = new Set(cleanA.split(' '));
      const wordsB = new Set(cleanB.split(' '));
      const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
      const union = new Set([...wordsA, ...wordsB]);
      return intersection.size / union.size;
    };

    let bestSimilarity = 0;
    let bestStart = -1;
    let occurrencesWithSimilarScore = 0;

    for (let start = 0; start <= originalLines.length - targetLines.length; start++) {
      let totalSim = 0;
      for (let offset = 0; offset < targetLines.length; offset++) {
        totalSim += getLineSimilarity(originalLines[start + offset], targetLines[offset]);
      }
      const avgSim = totalSim / targetLines.length;

      if (avgSim > bestSimilarity) {
        bestSimilarity = avgSim;
        bestStart = start;
        occurrencesWithSimilarScore = 1;
      } else if (Math.abs(avgSim - bestSimilarity) < 0.05 && avgSim > 0.7) {
        occurrencesWithSimilarScore++;
      }
    }

    if (bestSimilarity >= 0.8 && bestStart !== -1 && occurrencesWithSimilarScore === 1) {
      const updatedLines = [
        ...originalLines.slice(0, bestStart),
        trimmedReplacement,
        ...originalLines.slice(bestStart + targetLines.length)
      ];
      return {
        content: updatedLines.join('\n'),
        similarity: bestSimilarity
      };
    }

    return null;
  }

  private static trimOuterBlankLines(text: string): string {
    const lines = text.split('\n');
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.join('\n');
  }

  private static hasLineWhitespaceDrift(originalContent: string, targetContent: string): boolean {
    if (!targetContent.includes('\n')) {
      const idx = originalContent.indexOf(targetContent);
      if (idx === -1) {
        return false;
      }
      const lineStart = originalContent.lastIndexOf('\n', idx - 1) + 1;
      const lineEnd = originalContent.indexOf('\n', idx);
      const lineEndIdx = lineEnd === -1 ? originalContent.length : lineEnd;
      const line = originalContent.slice(lineStart, lineEndIdx);
      const hasLeadingDrift = /^[ \t]+/.test(line);
      const hasTrailingDrift = /[ \t]+$/.test(line);
      return hasLeadingDrift || hasTrailingDrift;
    }
    return false;
  }

  private static replaceByLineMatch(
    normalizedOriginal: string,
    normalizedTarget: string,
    normalizedReplacement: string
  ): { content: string } | null {
    const originalLines = normalizedOriginal.split('\n');
    const targetLines = normalizedTarget.split('\n');

    if (targetLines.length === 0 || (targetLines.length === 1 && targetLines[0] === '')) {
      return null;
    }

    const normalizeLine = (line: string) => line.replace(/[ \t]+$/g, '').trimStart();

    const normalizedTargetLines = targetLines.map(normalizeLine);
    for (let start = 0; start <= originalLines.length - targetLines.length; start++) {
      let matches = true;
      for (let offset = 0; offset < targetLines.length; offset++) {
        if (normalizeLine(originalLines[start + offset]) !== normalizedTargetLines[offset]) {
          matches = false;
          break;
        }
      }

      if (matches) {
        const nextLines = [
          ...originalLines.slice(0, start),
          ...normalizedReplacement.split('\n'),
          ...originalLines.slice(start + targetLines.length)
        ];
        return {
          content: nextLines.join('\n')
        };
      }
    }

    return null;
  }

  private static async deleteFile(filePath?: string): Promise<string> {
    const resolved = this.resolveWorkspacePath(filePath);
    if (!resolved.ok) return resolved.error;
    const targetFile = resolved.absolutePath;
    if (!fs.existsSync(targetFile)) {
      return `Error: File not found: ${filePath}`;
    }
    fs.unlinkSync(targetFile);
    return `Success: Deleted file: ${vscode.workspace.asRelativePath(targetFile)}`;
  }

  private static async grepSearch(query?: string, directory?: string): Promise<string> {
    if (!query) return 'Error: query argument is missing';
    const resolved = this.resolveWorkspacePath(directory || '.', 'directory');
    if (!resolved.ok) return resolved.error;
    const startDir = resolved.absolutePath;
    if (!fs.existsSync(startDir)) {
      return `Error: Directory not found: ${startDir}`;
    }

    const results: string[] = [];
    await this.searchInDir(startDir, query, results);
    return results.join('\n') || `No matches found for "${query}"`;
  }

  private static async searchInDir(dir: string, query: string, results: string[]): Promise<void> {
    if (results.length > 50) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const lowerName = entry.name.toLowerCase();
        if (['node_modules', '.git', 'dist', 'out', 'build', '.next', 'bin', 'obj', 'vendor'].includes(lowerName)) {
          continue;
        }
        await this.searchInDir(fullPath, query, results);
      } else if (entry.isFile()) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          if (content.includes(query)) {
            const lines = content.split('\n');
            lines.forEach((line, idx) => {
              if (line.includes(query)) {
                results.push(`${vscode.workspace.asRelativePath(fullPath)}:L${idx + 1}: ${line.trim().substring(0, 100)}`);
              }
            });
          }
        } catch (e) {
          // ignore unreadable/binary files
        }
      }
    }
  }

  private static async webSearch(query?: string): Promise<string> {
    if (!query) return 'Error: query argument is missing';
    if (this.webSearchCount >= 5) {
      return 'Error: Firewall Block - Web search limit of 5 searches has been reached for this run.';
    }
    this.webSearchCount++;
    try {
      const config = vscode.workspace.getConfiguration('k-horizon');
      const firecrawlKey = config.get<string>('firecrawlApiKey', '');
      const firecrawlBaseUrl = config.get<string>('firecrawlBaseUrl', 'https://api.firecrawl.dev');

      if (firecrawlKey) {
        try {
          const response = await fetch(`${firecrawlBaseUrl}/v1/search`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${firecrawlKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ query, limit: 5 })
          });
          if (response.ok) {
            const json = await response.json() as any;
            if (json.success && Array.isArray(json.data)) {
              const results = json.data.map((item: any) => {
                return `Title: ${item.title || 'No Title'}\nURL: ${item.url || 'No URL'}\nSnippet: ${item.description || item.markdown || ''}\n`;
              });
              return results.join('\n---\n');
            }
          }
        } catch (err: any) {
          // ignore and fall through to DuckDuckGo fallback below
        }
      }

      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const html = await response.text();

      const results = [];
      const resultBlocks = html.split('<div class="result results_links results_links_deep web-result');

      for (let i = 1; i < resultBlocks.length && results.length < 5; i++) {
        const block = resultBlocks[i];
        const titleMatch = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!titleMatch) continue;

        let rawUrl = titleMatch[1];
        let title = titleMatch[2].replace(/<[^>]*>/g, '').trim();

        let realUrl = rawUrl;
        if (rawUrl.includes('uddg=')) {
          const parts = rawUrl.split('uddg=')[1].split('&')[0];
          realUrl = decodeURIComponent(parts);
        } else if (rawUrl.startsWith('//')) {
          realUrl = 'https:' + rawUrl;
        }

        const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
        let snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, '').trim() : '';

        results.push({
          title,
          url: realUrl,
          snippet
        });
      }

      if (results.length === 0) {
        return `Web Search Results for "${query}": No results found.`;
      }

      return `Web Search Results for "${query}":\n\n` + results.map((r, i) => 
        `${i + 1}. **${r.title}**\n   URL: ${r.url}\n   Snippet: ${r.snippet}`
      ).join('\n\n');
    } catch (e: any) {
      return `Error performing web search: ${e.message}`;
    }
  }

  private static async fetchWebpage(url?: string): Promise<string> {
    if (!url) return 'Error: url argument is missing';
    try {
      const config = vscode.workspace.getConfiguration('k-horizon');
      const firecrawlKey = config.get<string>('firecrawlApiKey', '');
      const firecrawlBaseUrl = config.get<string>('firecrawlBaseUrl', 'https://api.firecrawl.dev');

      if (firecrawlKey) {
        try {
          const response = await fetch(`${firecrawlBaseUrl}/v1/scrape`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${firecrawlKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url, formats: ['markdown'] })
          });
          if (response.ok) {
            const json = await response.json() as any;
            if (json.success && json.data && json.data.markdown) {
              const text = json.data.markdown;
              const truncated = ToolManager.truncateForModel(text);
              return `Content of page ${url} (scraped via Firecrawl):\n\n${truncated}`;
            }
          }
        } catch (err: any) {
          // ignore and fall through to fetch below
        }
      }

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Content-type guard: only HTML pages are supported. Anything else
      // (PDF, JSON, image, plain-text RSS feed) would return garbled text
      // through the markdown parser and waste a model turn.
      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (
        contentType &&
        !contentType.includes('text/html') &&
        !contentType.includes('application/xhtml+xml')
      ) {
        return `Error: fetch_webpage only supports HTML pages (got ${contentType})`;
      }

      const html = await response.text();

      const text = ToolManager.htmlToMarkdown(html);

      const truncated = ToolManager.truncateForModel(text);

      return `Content of page ${url}:\n\n${truncated}`;
    } catch (e: any) {
      return `Error fetching webpage: ${e.message}`;
    }
  }

  /**
   * Maximum number of characters from a fetched page returned to the model.
   * Keeps the per-tool output predictable so a single web fetch can't blow
   * the agent's context budget. ~12k chars matches the budget used by
   * `executeTools` for `run_command` results in agent-graph.ts.
   */
  private static readonly FETCH_MAX_CHARS = 12000;
  private static readonly FETCH_HEAD_CHARS = 6000;
  private static readonly FETCH_TAIL_CHARS = 6000;

  /**
   * Head+tail truncation. If the input fits, returns it as-is. Otherwise
   * keeps the first {@link FETCH_HEAD_CHARS} and last {@link FETCH_TAIL_CHARS}
   * characters with an explicit marker between them, so the model can see
   * the truncation happened instead of silently receiving a clipped prefix.
   */
  public static truncateForModel(text: string): string {
    if (text.length <= ToolManager.FETCH_MAX_CHARS) {
      return text;
    }
    const head = text.substring(0, ToolManager.FETCH_HEAD_CHARS);
    const tail = text.substring(text.length - ToolManager.FETCH_TAIL_CHARS);
    const middleDropped = text.length - ToolManager.FETCH_HEAD_CHARS - ToolManager.FETCH_TAIL_CHARS;
    return (
      head +
      `\n\n... [TRUNCATED ${middleDropped} MIDDLE CHARACTERS OF ${text.length}-CHAR PAGE; TAIL FOLLOWS] ...\n\n` +
      tail
    );
  }

  /**
   * Convert an HTML string to a readable Markdown approximation using
   * `cheerio` so we get a real DOM instead of fragile nested-regex parsing.
   *
   * Preservation rules:
   *   - `<a href>` becomes `[text](url)` so link targets reach the model.
   *   - `<pre><code>` becomes a fenced code block; standalone `<code>` is inline.
   *   - `<table>` becomes a pipe-table (basic, no alignment hints).
   *   - `<img alt src>` becomes `[alt](src)` so image captions/URLs survive.
   *   - Headings, lists, bold/italic all preserved.
   *
   * Stripping rules:
   *   - `<script>`, `<style>`, `<noscript>` always removed.
   *   - `<header>`, `<nav>`, `<footer>`, `<aside>` removed ONLY when the page
   *     also has a `<main>` or `<article>` with substantive content. If the
   *     whole page lives in a header (e.g. a tiny landing page), keep it.
   */
  public static htmlToMarkdown(html: string): string {
    // Lazy-require cheerio so the rest of the module loads even if cheerio
    // is somehow missing in a user install.
    let load: ((input: string) => CheerioAPI) | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      load = require('cheerio').load as (input: string) => CheerioAPI;
    } catch {
      // Fallback: return the raw HTML stripped of scripts/styles if cheerio
      // is unavailable. Better than throwing inside a tool handler.
      const stripped = html
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[\s\S]*?<\/style>/gi, '');
      return stripped.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (!load) {
      return '';
    }

    const $ = load(html);

    // Always remove script/style/noscript/template content.
    $('script, style, noscript, template').remove();

    // Conditionally remove chrome (header/nav/footer/aside) — only if the
    // page has a meaningful main/article region. Otherwise these tags may
    // contain the only content (e.g. a single-section landing page).
    const hasMain = $('main').length > 0 || $('article').length > 0;
    if (hasMain) {
      $('header, nav, footer, aside').remove();
    }

    // Tables → markdown. We do this on the cheerio tree before serializing
    // because the default `.html()` output for a table is unusable.
    $('table').each((_, table) => {
      const $table = $(table);
      const rows: string[] = [];
      $table.find('tr').each((_ri, tr) => {
        const cells: string[] = [];
        $(tr).find('th, td').each((_ci, cell) => {
          // Recursively convert cell contents to markdown text first.
          const cellMd = ToolManager._inlineMarkdown($(cell).html() || '');
          cells.push(cellMd.replace(/\|/g, '\\|').trim());
        });
        rows.push(`| ${cells.join(' | ')} |`);
      });
      if (rows.length > 0) {
        // Insert a separator row right after the first row.
        const cols = (rows[0].match(/\|/g) || []).length - 1;
        const sep = `| ${Array(Math.max(cols, 1)).fill('---').join(' | ')} |`;
        rows.splice(1, 0, sep);
      }
      $table.replaceWith(rows.join('\n'));
    });

    // Code blocks: <pre><code> → fenced ``` ... ```
    $('pre').each((_, pre) => {
      const $pre = $(pre);
      const codeEl = $pre.find('code').first();
      const codeText = codeEl.length > 0
        ? codeEl.text()
        : $pre.text();
      const langMatch = (codeEl.attr('class') || '').match(/language-([\w-]+)/);
      const lang = langMatch ? langMatch[1] : '';
      $pre.replaceWith('\n```' + lang + '\n' + codeText + '\n```\n');
    });

    // Inline <code> → `code`. Skip ones already inside a <pre> (we handled those).
    $('code').each((_, code) => {
      const $code = $(code);
      if ($code.parents('pre').length === 0) {
        $code.replaceWith('`' + $code.text() + '`');
      }
    });

    // Links → [text](href). Preserve link text even if empty (still show URL).
    $('a').each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      const text = $a.text().trim();
      if (!href) {
        return; // keep as plain text
      }
      const replacement = text ? `[${text}](${href})` : `<${href}>`;
      $a.replaceWith(replacement);
    });

    // Images → [alt](src).
    $('img').each((_, img) => {
      const $img = $(img);
      const alt = $img.attr('alt') || '';
      const src = $img.attr('src') || '';
      if (src) {
        $img.replaceWith(alt ? `![${alt}](${src})` : `<${src}>`);
      } else {
        $img.remove();
      }
    });

    // Headings.
    $('h1').each((_, el) => { $(el).replaceWith('\n# ' + $(el).text() + '\n'); });
    $('h2').each((_, el) => { $(el).replaceWith('\n## ' + $(el).text() + '\n'); });
    $('h3').each((_, el) => { $(el).replaceWith('\n### ' + $(el).text() + '\n'); });
    $('h4').each((_, el) => { $(el).replaceWith('\n#### ' + $(el).text() + '\n'); });
    $('h5').each((_, el) => { $(el).replaceWith('\n##### ' + $(el).text() + '\n'); });
    $('h6').each((_, el) => { $(el).replaceWith('\n###### ' + $(el).text() + '\n'); });

    // Paragraphs.
    $('p').each((_, el) => { $(el).replaceWith('\n' + $(el).text() + '\n'); });

    // Line breaks.
    $('br').each((_, el) => { $(el).replaceWith('\n'); });

    // Bold / italic.
    $('strong, b').each((_, el) => { $(el).replaceWith('**' + $(el).text() + '**'); });
    $('em, i').each((_, el) => { $(el).replaceWith('*' + $(el).text() + '*'); });

    // List items. We don't try to wrap in ordered/unordered list wrappers —
    // the model doesn't care, and inline `-` markers are easier to read.
    $('li').each((_, el) => { $(el).replaceWith('\n- ' + $(el).text()); });

    // Serialize the body (or the whole doc if there's no <body>).
    // After all `.replaceWith(...)` calls above, the tree's `.html()`
    // already contains our markdown-formatted strings interleaved with any
    // remaining raw HTML. Strip remaining tags to get plain text + markdown.
    const $mutated = load($.html());
    const bodyEl = $mutated('body');
    const markdown = bodyEl.length > 0 ? bodyEl.text() : $mutated.root().text();

    // Collapse whitespace sensibly. We track fenced code-block state so we
    // don't touch indentation inside ``` blocks. Cheerio's mutation can leave
    // stray indent at the start of block elements (tables especially) when
    // adjacent text nodes have been replaced; we strip that without breaking
    // code-block content.
    const lines = markdown.split('\n');
    let inFence = false;
    const cleaned = lines.map(line => {
      const trimmed = line.replace(/[ \t]+/g, ' ').trimEnd();
      if (trimmed.startsWith('```')) {
        inFence = !inFence;
        return trimmed;
      }
      return inFence ? line : trimmed;
    });
    return cleaned.join('\n').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  }

  /**
   * Helper: convert an HTML fragment to inline markdown (no block-level
   * re-wrapping). Used for table cells.
   */
  private static _inlineMarkdown(html: string): string {
    // Minimal recursion: strip tags, decode common entities.
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Find the nearest directory containing a package.json by walking up from
   * the given starting path. This addresses the common monorepo case where
   * the workspace root is `c:\...\microservices` but `package.json` actually
   * lives in `microservices\services\auth`. Without this, every `npm install`
   * would fail with ENOENT for package.json.
   */
  private static findPackageJsonDir(startDir: string): string | null {
    try {
      let current = path.resolve(startDir);
      const root = path.parse(current).root;
      // Hard cap: don't walk more than 6 levels up to avoid scanning unrelated disks
      for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(current, 'package.json'))) {
          return current;
        }
        if (current === root) break;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    } catch {
      // ignore — fall through to null
    }
    return null;
  }

  private static async runCommand(command?: string, directory?: string, timeoutMs = 60000): Promise<string> {
    if (!command) return 'Error: command argument is missing';
    const commandRisk = this.isDangerousCommand(command);
    if (commandRisk) return commandRisk;

    const unusualWarning = this.warnIfUnusualCommand(command);
    const advisoryPrefix = unusualWarning ? unusualWarning + '\n\n' : '';

    const installLocalCheck = this.validatePackageInstallCommand(command);
    if (installLocalCheck) return installLocalCheck;

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      return 'Error: No workspace folder open to run commands';
    }

    const formatPreflightFailure = (
      message: string,
      category: string,
      remediation?: string
    ): string => {
      let result = `[EXIT_CODE: null]\n`;
      result += `[SIGNAL: null]\n`;
      result += `[FAILED: true]\n`;
      result += `[CATEGORY: ${category}]\n\n`;
      result += `[COMMAND FAILED] ${message}\n`;
      if (remediation) {
        result += `\n[REMEDIATION HINT] ${remediation}\n`;
      }
      result += `\n[ELAPSED TIME: 0ms]\n`;
      return result;
    };

    // Resolve directory if provided, otherwise fall back to the workspace root.
    let cwd = workspaceRoot;
    if (directory) {
      const resolved = this.resolveWorkspacePath(directory, 'directory');
      if (!resolved.ok) return resolved.error;
      const targetDir = resolved.absolutePath;
      if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
        cwd = targetDir;
      } else {
        return formatPreflightFailure(
          `Specified directory does not exist or is not a directory: ${directory}`,
          'enoent',
          'Pass a directory path that exists inside the current workspace.'
        );
      }
    }

    // If the command targets npm and there's no package.json at cwd,
    // auto-promote to the nearest ancestor directory that has one.
    // This handles the "microservices" monorepo layout without requiring the
    // LLM to guess the correct `directory` argument every time.
    //
    // EXCEPTION: npm init, npm create, and npx create-* are project-scaffolding
    // commands that do NOT require a pre-existing package.json — they CREATE one.
    const isNpmCommand = /^\s*(?:npm|npx|pnpm|yarn)\b/i.test(command);
    if (isNpmCommand) {
      const isScaffoldCmd = /\b(?:npm\s+(?:init|create)\b|npx\s+create-|yarn\s+create\b|pnpm\s+create\b)/i.test(command);
      if (!isScaffoldCmd) {
        const pkgDir = this.findPackageJsonDir(cwd);
        if (pkgDir && pkgDir !== cwd) {
          cwd = pkgDir;
        }
        if (!fs.existsSync(path.join(cwd, 'package.json'))) {
          return formatPreflightFailure(
            `No package.json found in ${cwd} or any parent directory.`,
            'missing-package-json',
            'Run `npm init -y` first to create one, or pass the correct directory containing package.json.'
          );
        }
      }
    }

    // Pre-flight: detect missing npm scripts before running (saves a full
    // 60-second timeout when the LLM hallucinates a script name).
    const preflight = inspectPlannedCommand(command, cwd);
    if (!preflight.ok) {
      const category = /does not define|script/i.test(preflight.reason) ? 'missing-script' : 'unknown';
      return formatPreflightFailure(preflight.reason, category, preflight.reason);
    }

    const startTime = Date.now();

    // On Windows, npm and npx are .cmd shims that cannot be launched by
    // child_process.execFile() without `shell: true`. We force `shell: true`
    // explicitly so npm.cmd resolution goes through ComSpec / cmd.exe.
    // We also bump the maxBuffer so that large npm logs aren't truncated
    // mid-error-block (the previous default of 1MB silently cut off
    // the npm ERR! block for big projects).
    const shellSetting: string | true = process.platform === 'win32'
      ? (vscode.env.shell || process.env.ComSpec || 'cmd.exe')
      : true;
    const config = vscode.workspace.getConfiguration('k-horizon');
    const sandboxMode = config.get<string>('sandboxMode', 'None');
    let finalCommand = command;
    let isDocker = false;

    if (sandboxMode === 'Docker') {
      if (!this.commandExists('docker')) {
        return formatPreflightFailure(
          'Docker is not installed or not available on your system PATH.',
          'command-not-found',
          'Install Docker, start Docker Desktop, or disable Docker sandbox mode in K-Horizon settings.'
        );
      }
      try {
        const tempScriptDir = path.join(workspaceRoot, '.k-horizon');
        if (!fs.existsSync(tempScriptDir)) {
          fs.mkdirSync(tempScriptDir, { recursive: true });
        }
        const scriptPath = path.join(tempScriptDir, 'sandbox_run.sh');
        const normalizedCommand = command.replace(/\r\n/g, '\n');
        fs.writeFileSync(scriptPath, `set -e\n${normalizedCommand}`, 'utf8');

        const relCwd = path.relative(workspaceRoot, cwd).replace(/\\/g, '/');
        const containerWd = relCwd ? `/workspace/${relCwd}` : '/workspace';

        const userArg = (process.getuid && process.getgid) ? `--user ${process.getuid()}:${process.getgid()}` : '';
        finalCommand = `docker run --rm ${userArg} -v "${workspaceRoot}:/workspace" -w "${containerWd}" node:18-alpine sh /workspace/.k-horizon/sandbox_run.sh`;
        isDocker = true;
      } catch (err: any) {
        isDocker = false;
        finalCommand = command;
      }
    }

    const subCommands = command.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    return new Promise((resolve) => {
      const runLocalSequentially = (cmds: string[], warningMsg?: string): Promise<string> => {
        return new Promise((resolveSub) => {
          let accumulatedStdout = '';
          let accumulatedStderr = '';
          let elapsedTotal = 0;
          let cmdIndex = 0;

          const runNext = () => {
            if (cmdIndex >= cmds.length) {
              let result = warningMsg ? warningMsg + '\n\n' : '';
              result += `[EXIT_CODE: 0]\n`;
              result += `[SIGNAL: null]\n`;
              result += `[FAILED: false]\n\n`;
              if (accumulatedStdout) result += `[STDOUT]\n${accumulatedStdout}\n`;
              if (accumulatedStderr) result += `[STDERR]\n${accumulatedStderr}\n`;
              result += `\n[ELAPSED TIME: ${elapsedTotal}ms]\n`;
              resolveSub(result);
              return;
            }

            const activeCmd = cmds[cmdIndex];
            const startTime = Date.now();
            const child = exec(activeCmd, {
              cwd,
              timeout: timeoutMs,
              shell: shellSetting,
              maxBuffer: 16 * 1024 * 1024,
              windowsHide: true,
            } as any, (error: any, stdout: string, stderr: string) => {
              this.activeProcesses.delete(child);
              const elapsedMs = Date.now() - startTime;
              elapsedTotal += elapsedMs;

              accumulatedStdout += `> ${activeCmd}\n${stdout || ''}\n`;
              if (stderr) {
                accumulatedStderr += `> ${activeCmd} (stderr)\n${stderr}\n`;
              }

              const exitCode: number | null = error && typeof error.code === 'number' ? error.code : (error ? null : 0);
              const signal: string | null = error && error.signal ? String(error.signal) : null;
              
              if (exitCode !== 0 || error) {
                const report = parseCommandFailure(stdout || '', stderr || '', exitCode, signal, workspaceRoot);
                let result = warningMsg ? warningMsg + '\n\n' : '';
                result += `[EXIT_CODE: ${exitCode === null ? 'null' : exitCode}]\n`;
                result += `[SIGNAL: ${signal || 'null'}]\n`;
                result += `[FAILED: true]\n`;
                if (report.npmErrorCode) result += `[NPM_ERR_CODE: ${report.npmErrorCode}]\n`;
                if (report.npmErrno !== null) result += `[NPM_ERRNO: ${report.npmErrno}]\n`;
                if (report.suspectedFile) result += `[SUSPECTED_FILE: ${report.suspectedFile}]\n`;
                if (report.category && report.category !== 'success') result += `[CATEGORY: ${report.category}]\n`;
                result += '\n';

                if (accumulatedStdout) result += `[STDOUT]\n${accumulatedStdout}\n`;
                if (accumulatedStderr) result += `[STDERR]\n${accumulatedStderr}\n`;
                
                result += `[COMMAND FAILED] Sequential execution halted at command: "${activeCmd}" (Exit code ${exitCode}).\n`;
                if (report.remediation) result += `\n[REMEDIATION HINT] ${report.remediation}\n`;
                result += `\n[ELAPSED TIME: ${elapsedTotal}ms]\n`;
                resolveSub(result);
                return;
              }

              cmdIndex++;
              runNext();
            });
            this.activeProcesses.add(child);
          };

          runNext();
        });
      };

      if (!isDocker) {
        runLocalSequentially(subCommands, advisoryPrefix || undefined).then(resolve);
        return;
      }

      try {
        const child = exec(finalCommand, {
          cwd,
          timeout: timeoutMs,
          shell: shellSetting,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        } as any, (error: any, stdout: string, stderr: string) => {
          this.activeProcesses.delete(child);

          if (isDocker) {
            try {
              const scriptPath = path.join(workspaceRoot, '.k-horizon', 'sandbox_run.sh');
              if (fs.existsSync(scriptPath)) {
                fs.unlinkSync(scriptPath);
              }
            } catch (e) {}
          }

          const elapsedMs = Date.now() - startTime;
          const exitCode: number | null = error && typeof error.code === 'number' ? error.code : (error ? null : 0);
          const signal: string | null = error && error.signal ? String(error.signal) : null;

          const stderrStr = stderr || '';
          const errorMsg = error ? String(error.message) : '';
          const isDockerMissing = isDocker && (
            exitCode === 127 ||
            (exitCode === 1 && (
              stderrStr.includes('docker:') ||
              stderrStr.includes('daemon') ||
              errorMsg.includes('docker') ||
              errorMsg.includes('daemon')
            ))
          );

          if (isDockerMissing) {
            runLocalSequentially(subCommands, `[WARNING] Docker sandbox environment is not running or not installed. Fell back to unsandboxed host machine execution.`).then(resolve);
            return;
          }

          const report = parseCommandFailure(stdout || '', stderr || '', exitCode, signal, workspaceRoot);

          let result = `[SANDBOX: Docker node:18-alpine]\n`;
          result += `[EXIT_CODE: ${exitCode === null ? 'null' : exitCode}]\n`;
          result += `[SIGNAL: ${signal || 'null'}]\n`;
          result += `[FAILED: ${report.failed}]\n`;
          if (report.npmErrorCode) result += `[NPM_ERR_CODE: ${report.npmErrorCode}]\n`;
          if (report.npmErrno !== null) result += `[NPM_ERRNO: ${report.npmErrno}]\n`;
          if (report.suspectedFile) result += `[SUSPECTED_FILE: ${report.suspectedFile}]\n`;
          if (report.debugLogPath) result += `[NPM_DEBUG_LOG: ${report.debugLogPath}]\n`;
          if (report.category && report.category !== 'success') result += `[CATEGORY: ${report.category}]\n`;
          result += '\n';

          if (stdout) result += `[STDOUT]\n${stdout}\n`;
          if (stderr) result += `[STDERR]\n${stderr}\n`;

          if (error) {
            if (error.killed) {
              result += `[COMMAND TIMEOUT] Execution aborted after exceeding the timeout of ${timeoutMs}ms.\n`;
            } else if (report.failed) {
              result += `[COMMAND FAILED] Exit code ${exitCode}${signal ? ' (signal ' + signal + ')' : ''}.\n`;
            } else {
              result += `[COMMAND ERROR] ${error.message}\n`;
            }
          }
          if (report.remediation) result += `\n[REMEDIATION HINT] ${report.remediation}\n`;
          result += `\n[ELAPSED TIME: ${elapsedMs}ms]\n`;
          resolve(result);
        });
        this.activeProcesses.add(child);
      } catch (err: any) {
        runLocalSequentially(subCommands, `[WARNING] Docker sandbox setup failed: ${err.message}. Fell back to unsandboxed host execution.`).then(resolve);
      }
    });
  }

  private static async getDiagnostics(filePath?: string): Promise<string> {
    // Force the TS / language service to refresh before reading diagnostics.
    // Previously this returned the cached snapshot, which meant an agent edit
    // that just landed was not visible to get_diagnostics for up to several
    // seconds. We trigger a no-op workspace edit on each target file to nudge
    // the language service to re-analyze.
    try {
      const tryRefresh = (cmd: string, ...args: any[]) =>
        Promise.resolve(vscode.commands.executeCommand(cmd, ...args))
          .catch(() => undefined);

      if (filePath) {
        const resolved = this.resolveWorkspacePath(filePath);
        if (!resolved.ok) return resolved.error;
        const targetFile = resolved.absolutePath;
        const uri = vscode.Uri.file(targetFile);
        const doc = await vscode.workspace.openTextDocument(uri);
        // Force a re-analysis by toggling a no-op diagnostic collection request.
        await tryRefresh('vscode.executeCodeActionProvider', uri, {
          diagnostics: [],
          only: ['quickfix'],
        });
        // Touch the document so the language service invalidates its cache.
        if (doc.languageId !== 'plaintext') {
          await tryRefresh('typescript.reloadProjects');
        }
      } else {
        // Workspace-wide: trigger a project-wide TS refresh.
        await tryRefresh('typescript.reloadProjects');
      }
    } catch {
      // Best effort — never let refresh failures block diagnostics output.
    }

    // Wait/poll diagnostics up to 900ms to allow the language server to settle
    let diagnostics = vscode.languages.getDiagnostics();
    let hasDiagnostics = diagnostics.some(([_, diags]) => diags.length > 0);
    
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise(r => setTimeout(r, 300));
      diagnostics = vscode.languages.getDiagnostics();
      const currentHas = diagnostics.some(([_, diags]) => diags.length > 0);
      if (currentHas !== hasDiagnostics) {
        break; // diagnostics updated, stop waiting
      }
    }
    let result = '';
    for (const [uri, fileDiagnostics] of diagnostics) {
      if (filePath) {
        const resolved = this.resolveWorkspacePath(filePath);
        if (!resolved.ok) return resolved.error;
        const targetFile = resolved.absolutePath;
        if (uri.fsPath.toLowerCase() !== targetFile.toLowerCase()) {
          continue;
        }
      }
      if (fileDiagnostics.length === 0) continue;

      const fileRelPath = vscode.workspace.asRelativePath(uri);
      if (fileRelPath.includes('node_modules') || fileRelPath.includes('.git') || fileRelPath.includes('dist')) {
        continue;
      }

      result += `File: ${fileRelPath}\n`;
      for (const diag of fileDiagnostics) {
        const severity = vscode.DiagnosticSeverity[diag.severity];
        result += `  [${severity}] Line ${diag.range.start.line + 1}: ${diag.message}\n`;
      }
    }
    return result || 'No diagnostics/errors found.';
  }

  /**
   * Read a file back from disk after a write/edit so the model sees the post-change
   * state and any errors introduced by its own edit (e.g. off-by-one line shifts,
   * accidental overwrites of adjacent blocks). Returns the current on-disk content
   * plus any diagnostics for the file. Use this after every successful write_file
   * or edit_file to catch "edit succeeded but introduced a new TS error" cases.
   */
  public static async verifyEdit(filePath?: string): Promise<string> {
    if (!filePath) return 'Error: file_path argument is required for verify_edit';

    const resolved = this.resolveWorkspacePath(filePath);
    if (!resolved.ok) return resolved.error;
    const targetFile = resolved.absolutePath;
    if (!fs.existsSync(targetFile)) {
      return `Error: File not found: ${filePath}`;
    }

    const content = fs.readFileSync(targetFile, 'utf8');
    const diagnostics = await this.getDiagnostics(filePath);
    const lineCount = content.split(/\r?\n/).length;
    const charCount = content.length;

    return `Verification for ${vscode.workspace.asRelativePath(targetFile)} (${charCount} chars, ${lineCount} lines):\n` +
           `---\n${content}\n---\n\nDiagnostics:\n${diagnostics}`;
  }

  private static async getActiveEditorContext(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return 'No active editor found.';
    }
    const doc = editor.document;
    const relativePath = vscode.workspace.asRelativePath(doc.uri);
    const selection = editor.selection;
    const cursorLine = selection.active.line + 1;
    const cursorChar = selection.active.character;

    let selectedText = doc.getText(selection);
    if (selectedText) {
      selectedText = `\nSelected Text:\n\`\`\`\n${selectedText}\n\`\`\`\n`;
    }

    return `Active File: ${relativePath}\n` +
           `Cursor Position: Line ${cursorLine}, Character ${cursorChar}\n` +
           selectedText;
  }

  private static async searchWorkspaceSymbols(query?: string): Promise<string> {
    if (!query) return 'Error: query argument is missing';
    try {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query
      );
      if (!symbols || symbols.length === 0) {
        return `No symbols found matching "${query}"`;
      }
      return symbols.slice(0, 50).map(sym => {
        const container = sym.containerName ? ` (in ${sym.containerName})` : '';
        const relPath = vscode.workspace.asRelativePath(sym.location.uri);
        const kind = vscode.SymbolKind[sym.kind] || 'Symbol';
        return `[${kind}] ${sym.name}${container} at ${relPath}:L${sym.location.range.start.line + 1}`;
      }).join('\n');
    } catch (e: any) {
      return `Error searching symbols: ${e.message}`;
    }
  }

  private static async findReferences(filePath?: string, line?: string, character?: string): Promise<string> {
    if (!filePath || !line || !character) {
      return 'Error: file_path, line, and character arguments are required';
    }
    const resolved = this.resolveWorkspacePath(filePath);
    if (!resolved.ok) return resolved.error;
    const targetFile = resolved.absolutePath;
    const uri = vscode.Uri.file(targetFile);
    const pos = new vscode.Position(parseInt(line) - 1, parseInt(character));
    try {
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider',
        uri,
        pos
      );
      if (!locations || locations.length === 0) {
        return 'No references found.';
      }
      return locations.map(loc => {
        const relPath = vscode.workspace.asRelativePath(loc.uri);
        return `${relPath}:L${loc.range.start.line + 1}`;
      }).join('\n');
    } catch (e: any) {
      return `Error finding references: ${e.message}`;
    }
  }

  private static async findDefinitions(filePath?: string, line?: string, character?: string): Promise<string> {
    if (!filePath || !line || !character) {
      return 'Error: file_path, line, and character arguments are required';
    }
    const resolved = this.resolveWorkspacePath(filePath);
    if (!resolved.ok) return resolved.error;
    const targetFile = resolved.absolutePath;
    const uri = vscode.Uri.file(targetFile);
    const pos = new vscode.Position(parseInt(line) - 1, parseInt(character));
    try {
      const locations = await vscode.commands.executeCommand<any>(
        'vscode.executeDefinitionProvider',
        uri,
        pos
      );
      if (!locations || locations.length === 0) {
        return 'No definitions found.';
      }
      const locs = Array.isArray(locations) ? locations : [locations];
      return locs.map(loc => {
        if (loc.uri) {
          const relPath = vscode.workspace.asRelativePath(loc.uri);
          return `${relPath}:L${loc.range.start.line + 1}`;
        } else if (loc.targetUri) {
          const relPath = vscode.workspace.asRelativePath(loc.targetUri);
          const range = loc.targetRange || loc.targetSelectionRange;
          return `${relPath}:L${(range ? range.start.line : 0) + 1}`;
        }
        return 'Unknown location format';
      }).join('\n');
    } catch (e: any) {
      return `Error finding definitions: ${e.message}`;
    }
  }

  private static async traceSymbolDependency(symbolName?: string, depth = 2): Promise<string> {
    if (!symbolName) return 'Error: symbol_name argument is required';

    try {
      // 1. Locate symbol definition using executeWorkspaceSymbolProvider
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        symbolName
      );

      if (!symbols || symbols.length === 0) {
        return `Error: Could not find definition for symbol "${symbolName}" in workspace. Make sure language services are initialized.`;
      }

      // Filter for exact symbol name matches
      const targetSymbol = symbols.find(sym => sym.name.toLowerCase() === symbolName.toLowerCase()) || symbols[0];
      const targetUri = targetSymbol.location.uri;
      const targetRange = targetSymbol.location.range;
      const targetPos = targetRange.start;
      const targetRelPath = vscode.workspace.asRelativePath(targetUri);

      // We will trace relations: caller -> callee
      const relations: Array<{ caller: string; callerFile: string; callee: string; calleeFile: string }> = [];
      const visited = new Set<string>();

      const traceQueue: Array<{ name: string; uri: vscode.Uri; pos: vscode.Position; currentDepth: number }> = [
        { name: targetSymbol.name, uri: targetUri, pos: targetPos, currentDepth: 1 }
      ];

      while (traceQueue.length > 0) {
        const current = traceQueue.shift()!;
        if (current.currentDepth > depth) continue;

        try {
          const refs = await vscode.commands.executeCommand<vscode.Location[]>(
            'vscode.executeReferenceProvider',
            current.uri,
            current.pos
          );

          if (refs && refs.length > 0) {
            for (const ref of refs) {
              const refRelPath = vscode.workspace.asRelativePath(ref.uri);
              
              // Skip if it's the definition itself
              if (refRelPath === vscode.workspace.asRelativePath(current.uri) && 
                  ref.range.start.line === current.pos.line) {
                continue;
              }

              // Find enclosing container (method/function/class name) for the reference
              let containerName = 'global_scope';
              try {
                const docSymbols = await vscode.commands.executeCommand<any[]>(
                  'vscode.executeDocumentSymbolProvider',
                  ref.uri
                );
                if (docSymbols && docSymbols.length > 0) {
                  const found = this.findEnclosingSymbol(docSymbols, ref.range.start);
                  if (found) {
                    containerName = `${found.name} (${vscode.SymbolKind[found.kind] || 'Symbol'})`;
                  }
                }
              } catch {}

              const relationKey = `${refRelPath}:${containerName} -> ${current.name}`;
              if (!visited.has(relationKey)) {
                visited.add(relationKey);
                relations.push({
                  caller: containerName,
                  callerFile: refRelPath,
                  callee: current.name,
                  calleeFile: vscode.workspace.asRelativePath(current.uri)
                });

                // If within depth, enqueue the caller to trace its callers
                if (current.currentDepth < depth) {
                  traceQueue.push({
                    name: containerName,
                    uri: ref.uri,
                    pos: ref.range.start,
                    currentDepth: current.currentDepth + 1
                  });
                }
              }
            }
          }
        } catch {}
      }

      // 2. Format output as a Mermaid diagram and lists
      let output = `## Symbol Dependency Graph for: \`${symbolName}\`\n\n`;
      output += `- **Definition Location:** \`${targetRelPath}:L${targetPos.line + 1}\`\n`;
      output += `- **Symbol Type:** ${vscode.SymbolKind[targetSymbol.kind] || 'Unknown'}\n\n`;

      if (relations.length === 0) {
        output += `No incoming call references found for \`${symbolName}\` within depth limit ${depth}.\n`;
        return output;
      }

      output += `### Mermaid Call Graph:\n\n\`\`\`mermaid\ngraph TD\n`;
      output += `  %% Node Styles\n`;
      output += `  classDef target fill:#4CAF50,stroke:#388E3C,stroke-width:2px,color:#fff;\n`;
      output += `  classDef caller fill:#2196F3,stroke:#0b7dda,stroke-width:1px,color:#fff;\n\n`;

      const nodeIds = new Map<string, string>();
      let nodeIdCounter = 0;
      const getOrCreateNodeId = (name: string, file: string) => {
        const key = `${file}:${name}`;
        if (!nodeIds.has(key)) {
          const id = `node_${nodeIdCounter++}`;
          nodeIds.set(key, id);
          
          const cleanLabel = `${name}\\n(${file})`;
          output += `  ${id}["${cleanLabel}"]\n`;
        }
        return nodeIds.get(key)!;
      };

      // Add target symbol style
      const targetNodeId = getOrCreateNodeId(targetSymbol.name, targetRelPath);
      output += `  class ${targetNodeId} target;\n`;

      // Build edges
      for (const rel of relations) {
        const callerId = getOrCreateNodeId(rel.caller, rel.callerFile);
        const calleeId = getOrCreateNodeId(rel.callee, rel.calleeFile);
        output += `  ${callerId} --> ${calleeId}\n`;
        
        if (calleeId === targetNodeId) {
          output += `  class ${callerId} caller;\n`;
        }
      }

      output += `\`\`\`\n\n`;
      
      output += `### Detailed Reference List:\n`;
      relations.forEach((rel, index) => {
        output += `${index + 1}. **Caller:** \`${rel.caller}\` in \`${rel.callerFile}\` calling \`${rel.callee}\` in \`${rel.calleeFile}\`\n`;
      });

      return output;
    } catch (e: any) {
      return `Error tracing symbol dependency: ${e.message}`;
    }
  }

  private static findEnclosingSymbol(symbols: any[], position: vscode.Position): any | null {
    let bestMatch: any | null = null;

    const traverse = (symList: any[]) => {
      for (const sym of symList) {
        const range = sym.range || sym.location?.range;
        if (range && range.start.line <= position.line && range.end.line >= position.line) {
          if (!bestMatch) {
            bestMatch = sym;
          } else {
            const bestRange = bestMatch.range || bestMatch.location?.range;
            if (bestRange && (range.end.line - range.start.line) <= (bestRange.end.line - bestRange.start.line)) {
              bestMatch = sym;
            }
          }
          if (sym.children && sym.children.length > 0) {
            traverse(sym.children);
          }
        }
      }
    };

    traverse(symbols);
    return bestMatch;
  }

  private static async replaceInFiles(query?: string, replacement?: string, includes?: string): Promise<string> {
    if (!query || replacement === undefined) {
      return 'Error: query and replacement arguments are required';
    }
    try {
      const globPattern = includes || '**/*';
      const uris = await vscode.workspace.findFiles(globPattern, '**/node_modules/**');
      let matchCount = 0;
      let fileCount = 0;

      for (const uri of uris) {
        const filePath = uri.fsPath;
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;

        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes(query)) {
          const newContent = content.split(query).join(replacement);
          fs.writeFileSync(filePath, newContent, 'utf8');
          matchCount += content.split(query).length - 1;
          fileCount++;
        }
      }
      return `Success: Replaced "${query}" with "${replacement}" in ${fileCount} files (${matchCount} occurrences total).`;
    } catch (e: any) {
      return `Error replacing in files: ${e.message}`;
    }
  }

  private static getFileMetadata(filePath?: string): string {
    if (!filePath) return 'Error: file_path argument is required';
    const resolved = this.resolveWorkspacePath(filePath);
    if (!resolved.ok) return resolved.error;
    const targetFile = resolved.absolutePath;

    try {
      if (!fs.existsSync(targetFile)) {
        return `Error: File not found: ${filePath}`;
      }
      const stat = fs.statSync(targetFile);
      const isDir = stat.isDirectory();
      
      let lineCount = 0;
      if (!isDir) {
        const content = fs.readFileSync(targetFile, 'utf8');
        lineCount = content.split(/\r?\n/).length;
      }

      const metadata = {
        path: vscode.workspace.asRelativePath(targetFile),
        type: isDir ? 'directory' : 'file',
        size_bytes: stat.size,
        line_count: lineCount,
        modified_time: new Date(stat.mtimeMs).toISOString(),
        created_time: new Date(stat.birthtimeMs).toISOString(),
        is_readonly: false
      };

      return JSON.stringify(metadata, null, 2);
    } catch (e: any) {
      return `Error fetching metadata: ${e.message}`;
    }
  }

  private static createDirectory(directoryPath?: string): string {
    if (!directoryPath) return 'Error: directory_path argument is required';
    const resolved = this.resolveWorkspacePath(directoryPath);
    if (!resolved.ok) return resolved.error;
    const targetDir = resolved.absolutePath;

    try {
      if (fs.existsSync(targetDir)) {
        return `Directory already exists: ${directoryPath}`;
      }
      fs.mkdirSync(targetDir, { recursive: true });
      return `Success: Created directory at ${directoryPath}`;
    } catch (e: any) {
      return `Error creating directory: ${e.message}`;
    }
  }

  private static async gitDiffFile(filePath?: string): Promise<string> {
    if (!filePath) return 'Error: file_path argument is required';
    const resolved = this.resolveWorkspacePath(filePath);
    if (!resolved.ok) return resolved.error;
    const targetFile = resolved.absolutePath;

    if (!fs.existsSync(targetFile)) {
      return `Error: File not found: ${filePath}`;
    }

    const workspaceRoot = getWorkspaceRoot();
    try {
      const relPath = path.relative(workspaceRoot, targetFile).replace(/\\/g, '/');
      const diffOutput = await this.runCommand(`git diff -- "${relPath}"`, workspaceRoot);
      if (!diffOutput || diffOutput.trim() === '' || diffOutput.includes('[COMMAND FAILED]')) {
        return `No uncommitted changes in git for file: ${relPath}`;
      }
      return diffOutput;
    } catch (e: any) {
      return `Error getting git diff for file: ${e.message}`;
    }
  }

  private static async showInfoMessage(message?: string): Promise<string> {
    if (!message) return 'Error: message argument is missing';
    vscode.window.showInformationMessage(message);
    return 'Success: Message shown to user.';
  }

  private static async getVSCodeExtensions(): Promise<string> {
    const extensions = vscode.extensions.all;
    const list = extensions
      .filter(ext => !ext.id.startsWith('vscode.'))
      .map(ext => `${ext.id} (v${ext.packageJSON.version})`)
      .join('\n');
    return list || 'No external extensions found.';
  }

  private static async sendToTerminal(command?: string, terminalName = 'K-Horizon Terminal'): Promise<string> {
    if (!command) return 'Error: command argument is missing';
    const installLocalCheck = this.validatePackageInstallCommand(command);
    if (installLocalCheck) return installLocalCheck;
    
    try {
      let terminal = vscode.window.terminals.find(t => t.name === terminalName);
      if (!terminal) {
        terminal = vscode.window.createTerminal(terminalName);
      }
      terminal.show(true);
      terminal.sendText(command);
      return `Success: Sent command "${command}" to terminal "${terminalName}"`;
    } catch (e: any) {
      return `Error sending command to terminal: ${e.message}`;
    }
  }

  private static async openFileToSide(filePath?: string): Promise<string> {
    if (!filePath) return 'Error: file_path argument is missing';
    try {
      const resolved = this.resolveWorkspacePath(filePath);
      if (!resolved.ok) return resolved.error;
      const targetFile = resolved.absolutePath;
      if (!fs.existsSync(targetFile)) {
        return `Error: File not found: ${filePath}`;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetFile));
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two });
      return `Success: Opened file ${filePath} to the side.`;
    } catch (e: any) {
      return `Error opening file to side: ${e.message}`;
    }
  }

  private static async previewHtml(filePath?: string, htmlContent?: string): Promise<string> {
    if (!filePath && !htmlContent) {
      return 'Error: either file_path or html_content argument is required';
    }
    try {
      let content = htmlContent || '';
      if (filePath) {
        const resolved = this.resolveWorkspacePath(filePath);
        if (!resolved.ok) return resolved.error;
        const targetFile = resolved.absolutePath;
        if (fs.existsSync(targetFile)) {
          content = fs.readFileSync(targetFile, 'utf8');
        } else {
          return `Error: File not found for preview: ${filePath}`;
        }
      }

      const panel = vscode.window.createWebviewPanel(
        'kHorizonPreview',
        `Preview: ${filePath ? path.basename(filePath) : 'HTML Content'}`,
        vscode.ViewColumn.Two,
        { enableScripts: true }
      );
      panel.webview.html = content;
      return `Success: Opened HTML preview panel.`;
    } catch (e: any) {
      return `Error opening HTML preview: ${e.message}`;
    }
  }

  private static async findFiles(pattern?: string): Promise<string> {
    if (!pattern) return 'Error: pattern argument is missing';
    try {
      const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
      if (uris.length === 0) {
        return `No files found matching pattern: ${pattern}`;
      }
      const filesList = uris.map(u => vscode.workspace.asRelativePath(u)).join('\n');
      return `Files matching "${pattern}":\n${filesList}`;
    } catch (e: any) {
      return `Error searching for files: ${e.message}`;
    }
  }

  private static async getFileOutline(filePath?: string): Promise<string> {
    if (!filePath) return 'Error: file_path argument is missing';
    try {
      const resolved = this.resolveWorkspacePath(filePath);
      if (!resolved.ok) return resolved.error;
      const targetFile = resolved.absolutePath;
      if (!fs.existsSync(targetFile)) {
        return `Error: File not found: ${filePath}`;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(targetFile));
      const symbols = await vscode.commands.executeCommand<any[]>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri
      );

      if (!symbols || symbols.length === 0) {
        return `No outline/symbols found in file: ${filePath}`;
      }

      const formatSymbol = (s: any, depth = 0): string => {
        const indent = '  '.repeat(depth);
        const name = s.name;
        const kind = vscode.SymbolKind[s.kind] || 'Unknown';
        const range = `Line ${s.range.start.line + 1}-${s.range.end.line + 1}`;
        let details = `${indent}- [${kind}] ${name} (${range})`;
        if (s.children && s.children.length > 0) {
          details += '\n' + s.children.map((c: any) => formatSymbol(c, depth + 1)).join('\n');
        }
        return details;
      };

      const outline = symbols.map(s => formatSymbol(s)).join('\n');
      return `Outline structure for "${filePath}":\n${outline}`;
    } catch (e: any) {
      return `Error generating outline: ${e.message}`;
    }
  }

  private static async gitStatus(): Promise<string> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      return 'Error: No workspace folder open for git';
    }
    return new Promise((resolve) => {
      const child = exec('git status --porcelain', { cwd: workspaceRoot }, (error, stdout, stderr) => {
        this.activeProcesses.delete(child);
        if (error) {
          resolve(`Error running git status: ${error.message}\n${stderr}`);
        } else {
          resolve(stdout.trim() || 'Git repository is clean. No modifications.');
        }
      });
      this.activeProcesses.add(child);
    });
  }

  private static async gitDiff(): Promise<string> {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      return 'Error: No workspace folder open for git';
    }
    return new Promise((resolve) => {
      const child = exec('git diff', { cwd: workspaceRoot }, (error, stdout, stderr) => {
        this.activeProcesses.delete(child);
        if (error) {
          resolve(`Error running git diff: ${error.message}\n${stderr}`);
        } else {
          resolve(stdout.trim() || 'No uncommitted diffs.');
        }
      });
      this.activeProcesses.add(child);
    });
  }

  private static findSystemBrowser(): string | undefined {
    if (process.platform === 'win32') {
      const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`
      ];
      for (const p of paths) {
        if (fs.existsSync(p)) return p;
      }
    } else if (process.platform === 'darwin') {
      const paths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
      ];
      for (const p of paths) {
        if (fs.existsSync(p)) return p;
      }
    } else {
      const paths = [
        '/usr/bin/google-chrome',
        '/usr/bin/microsoft-edge',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
      ];
      for (const p of paths) {
        if (fs.existsSync(p)) return p;
      }
    }
    return undefined;
  }

  private static async webScrape(url?: string, selector = 'body'): Promise<string> {
    if (!url) return 'Error: url argument is missing';
    await this.acquireBrowserSlot();
    let browser: any;
    try {
      let playwright;
      try {
        playwright = require('playwright-core');
      } catch (err: any) {
        console.error('Failed to load playwright-core:', err);
        return await this.fetchWebpageFallback(url);
      }

      const executablePath = this.findSystemBrowser();
      if (!executablePath) {
        return await this.fetchWebpageFallback(url);
      }

      browser = await playwright.chromium.launch({
        executablePath,
        headless: true
      });

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });

      const page = await context.newPage();

      await page.route('**/*', (route: any) => {
        const type = route.request().resourceType();
        if (['image', 'stylesheet', 'media', 'font'].includes(type)) {
          route.abort();
        } else {
          route.continue();
        }
      });

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

      let text = '';
      if (selector) {
        text = await page.$eval(selector, (el: any) => el.innerText || el.textContent || '');
      } else {
        text = await page.evaluate(() => document.body.innerText || '');
      }

      if (!text.trim()) {
        return `Web page loaded, but no text was found under selector "${selector}".`;
      }

      return `Successfully scraped "${url}":\n\n${text.substring(0, 15000)}`;
    } catch (e: any) {
      return `Scraping failed: ${e.message}. Falling back to standard fetch...\n\n` + await this.fetchWebpageFallback(url);
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (closeErr) {
          // Ignore close errors
        }
      }
      this.releaseBrowserSlot();
    }
  }

  private static async fetchWebpageFallback(url: string): Promise<string> {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 K-Horizon Scraper' }
      });
      if (!response.ok) {
        return `Fallback fetch failed: HTTP ${response.status} ${response.statusText}`;
      }
      const html = await response.text();
      return `Successfully fetched webpage content (HTML fallback):\n\n` + this.htmlToMarkdown(html);
    } catch (err: any) {
      return `Scraping and fetch failed completely: ${err.message}`;
    }
  }

  private static async getLibraryDocs(libraryName?: string, version = 'latest'): Promise<string> {
    if (!libraryName) return 'Error: library_name argument is missing';
    
    let lib = libraryName.toLowerCase().trim();
    // Parse devdocs.io URL or name pattern to extract the core library name
    if (lib.includes('devdocs')) {
      const parts = lib.split('/');
      const devdocsIdx = parts.findIndex(p => p.includes('devdocs'));
      if (devdocsIdx !== -1 && parts[devdocsIdx + 1]) {
        lib = parts[devdocsIdx + 1];
      } else {
        lib = parts[parts.length - 1] || lib;
      }
      lib = lib.replace(/[\?#\/].*$/, '').trim();
    }

    // Try to retrieve live documentation using Context7 MCP first
    try {
      const servers = MCPManager.getServersStatus();
      const hasContext7 = servers.some(s => s.name === 'Context7' && s.status === 'Connected');
      if (hasContext7) {
        const resolveResultStr = await MCPManager.callMcpTool('Context7', 'resolve-library-id', {
          libraryName: lib
        });
        
        let libraryId = '';
        const matches = resolveResultStr.match(/\/[a-zA-Z0-9_\-\.]+\/[a-zA-Z0-9_\-\.]+/g);
        if (matches && matches.length > 0) {
          libraryId = matches[matches.length - 1];
        } else {
          const simpleMatch = resolveResultStr.match(/\/[a-zA-Z0-9_\-\.]+/);
          if (simpleMatch) {
            libraryId = simpleMatch[0];
          }
        }

        if (libraryId) {
          const queryStr = `API SDK developer documentation overview installation configuration setup getting started code examples usage guide typescript programming reference ${version}`;
          const docsResultStr = await MCPManager.callMcpTool('Context7', 'query-docs', {
            context7CompatibleLibraryID: libraryId,
            topic: 'code',
            query: queryStr
          });
          if (docsResultStr && !docsResultStr.startsWith('[MCP TOOL ERROR]')) {
            return `### ${libraryName} (Live Docs from Context7)\n\n${docsResultStr}`;
          }
        }
      }
    } catch (err: any) {
      console.warn(`[getLibraryDocs] Context7 fetch failed: ${err.message}`);
    }

    const isLegacy = version === 'legacy' || version.startsWith('v18') || version.startsWith('v17') || version.startsWith('v3');
    
    const docs: Record<string, string> = {
      'express': `### Express.js Reference Sheet
Standard express server with routing, middleware, and error handling.
- Installation: \`npm install express @types/express\`
- Templates:
\`\`\`typescript
import express, { Request, Response, NextFunction } from 'express';

const app = express();
app.use(express.json());

// Router setup
app.get('/api/users', (req: Request, res: Response) => {
  res.json({ success: true, data: [] });
});

// Error middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(\`Server running on port \${PORT}\`));
\`\`\`
`,
      'react': isLegacy ? `### React 18 (Legacy) Reference Sheet
Common React 18 usage with client creation, hooks, and routing.
- Installation: \`npm install react react-dom @types/react @types/react-dom\`
- Mounting:
\`\`\`typescript
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);
\`\`\`
` : `### React 19 (Latest) Reference Sheet
Latest React 19 capabilities, Server Components, and hooks like useActionState/use.
- Mounting:
\`\`\`typescript
import { hydrateRoot } from 'react-dom/client';
import App from './App';

hydrateRoot(document.getElementById('root')!, <App />);
\`\`\`
- Action State Hook (useActionState):
\`\`\`typescript
import { useActionState } from 'react';

async function updateName(prevState: any, formData: FormData) {
  return { name: formData.get("name") };
}

function NameForm() {
  const [state, formAction, isPending] = useActionState(updateName, { name: "" });
  return (
    <form action={formAction}>
      <input name="name" />
      <button disabled={isPending}>Update</button>
    </form>
  );
}
\`\`\`
`,
      'playwright': `### Playwright Reference Sheet
End-to-end browser testing with custom assertions.
- Installation: \`npm install @playwright/test\`
- Test template:
\`\`\`typescript
import { test, expect } from '@playwright/test';

test('has title and navigates', async ({ page }) => {
  await page.goto('https://playwright.dev/');
  await expect(page).toHaveTitle(/Playwright/);
  
  const getStarted = page.locator('text=Get Started');
  await expect(getStarted).toBeVisible();
  await getStarted.click();
});
\`\`\`
`,
      'tailwindcss': isLegacy ? `### TailwindCSS v3 (Legacy) Configuration
- Installation: \`npm install -D tailwindcss postcss autoprefixer\`
- Config template (\`tailwind.config.js\`):
\`\`\`javascript
module.exports = {
  content: ["./src/**/*.{html,js,ts,jsx,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
}
\`\`\`
` : `### TailwindCSS v4 (Latest) Configuration
- Installation: \`npm install tailwindcss @tailwindcss/postcss postcss\`
- Config template:
CSS-first configuration using \`@theme\` directives inside the CSS file:
\`\`\`css
@import "tailwindcss";

@theme {
  --color-primary: #3b82f6;
  --font-display: "Outfit", sans-serif;
}
\`\`\`
`,
      'pg': `### Node Postgres (pg) pool & client configuration
- Installation: \`npm install pg @types/pg\`
- Config:
\`\`\`typescript
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/db',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

export const query = (text: string, params?: any[]) => pool.query(text, params);
\`\`\`
`,
      'supabase': `### Supabase JS Client Reference
- Installation: \`npm install @supabase/supabase-js\`
- Config:
\`\`\`typescript
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseKey);
\`\`\`
`
    };

    const docContent = docs[lib];
    if (docContent) return docContent;

    return `Standard documentation and templates for "${libraryName}" are not prepackaged. You can run "web_scrape" to query the web for detailed configurations and APIs.`;
  }

  private static async executeVSCodeCommand(commandId?: string, argumentsJson?: string): Promise<string> {
    if (!commandId) return 'Error: command_id argument is missing';
    try {
      let args: any[] = [];
      if (argumentsJson) {
        const parsed = JSON.parse(argumentsJson);
        args = Array.isArray(parsed) ? parsed : [parsed];
      }
      const result = await vscode.commands.executeCommand(commandId, ...args);
      return `Success: Executed VS Code command "${commandId}". Result: ${JSON.stringify(result) || 'void'}`;
    } catch (e: any) {
      return `Error executing VS Code command "${commandId}": ${e.message}`;
    }
  }

  private static httpsRequest(url: string, method: string, headers: Record<string, string>, body?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const options: https.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: method,
        headers: headers
      };
      
      const req = https.request(options, (res) => {
        let responseData = '';
        res.on('data', (chunk) => responseData += chunk);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(responseData);
          } else {
            reject(new Error(`HTTP Error ${res.statusCode}: ${responseData}`));
          }
        });
      });
      
      req.on('error', (err) => reject(err));
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  private static async createWebhookToken(): Promise<string> {
    try {
      const response = await this.httpsRequest(
        'https://webhook.site/token',
        'POST',
        { 'Accept': 'application/json', 'Content-Type': 'application/json' }
      );
      const data = JSON.parse(response);
      if (data && data.uuid) {
        return `Success: Created temporary webhook URL.\n\nWebhook URL: https://webhook.site/${data.uuid}\nToken ID: ${data.uuid}\n\nYou can send HTTP requests to this Webhook URL, then call get_webhook_requests with the Token ID to retrieve them.`;
      }
      return `Error: Unexpected response from Webhook.site: ${response}`;
    } catch (err: any) {
      return `Error: Failed to create temporary webhook: ${err.message}`;
    }
  }

  private static async getWebhookRequests(tokenId: string): Promise<string> {
    try {
      const response = await this.httpsRequest(
        `https://webhook.site/token/${tokenId}/requests`,
        'GET',
        { 'Accept': 'application/json' }
      );
      const data = JSON.parse(response);
      const requests = data.data || [];
      if (requests.length === 0) {
        return `No requests received at webhook token "${tokenId}" yet.`;
      }
      
      const formatted = requests.map((req: any, index: number) => {
        const bodyContent = typeof req.content === 'string' ? req.content : JSON.stringify(req.content);
        return `[Request #${index + 1} - ${req.created_at}]\n` +
          `Method: ${req.method}\n` +
          `IP: ${req.ip}\n` +
          `Headers: ${JSON.stringify(req.headers, null, 2)}\n` +
          `Query Parameters: ${JSON.stringify(req.query, null, 2)}\n` +
          `Content / Body: ${bodyContent}\n` +
          `----------------------------------------`;
      }).join('\n\n');
      
      return `Success: Retrieved ${requests.length} requests from webhook token "${tokenId}":\n\n${formatted}`;
    } catch (err: any) {
      return `Error: Failed to fetch webhook requests: ${err.message}`;
    }
  }

  private static async patchFileLines(
    filePath?: string,
    startLineStr?: string,
    endLineStr?: string,
    replacementContent?: string
  ): Promise<string> {
    const resolved = this.resolveWorkspacePath(filePath);
    if (!resolved.ok) return resolved.error;
    const targetFile = resolved.absolutePath;
    if (!fs.existsSync(targetFile)) {
      return `Error: File not found: ${filePath}`;
    }

    const startLine = parseInt(startLineStr || '', 10);
    const endLine = parseInt(endLineStr || '', 10);
    if (isNaN(startLine) || isNaN(endLine) || startLine < 1 || endLine < startLine) {
      return `Error: Invalid line range [${startLineStr}, ${endLineStr}]`;
    }

    const fileContent = fs.readFileSync(targetFile, 'utf8');
    const lines = fileContent.split(/\r?\n/);
    if (startLine > lines.length) {
      return `Error: start_line (${startLine}) is beyond file line count (${lines.length})`;
    }

    const eol = fileContent.includes('\r\n') ? '\r\n' : '\n';
    
    // Save original for diffing
    const tempDir = os.tmpdir();
    const randomId = Math.random().toString(36).substring(7);
    const fileName = path.basename(targetFile);
    const tempOriginalPath = path.join(tempDir, `k_horizon_patch_orig_${randomId}_${fileName}`);
    fs.writeFileSync(tempOriginalPath, fileContent, 'utf8');

    // Replace lines (inclusive, 1-indexed, so index is line - 1)
    const before = lines.slice(0, startLine - 1);
    const after = lines.slice(endLine);
    const newReplacementLines = replacementContent ? replacementContent.split(/\r?\n/) : [];
    const updatedLines = [...before, ...newReplacementLines, ...after];
    
    const updatedContent = updatedLines.join(eol);

    // Syntax validation check
    const syntaxCheck = this.validateSyntax(targetFile, updatedContent);
    if (!syntaxCheck.ok) {
      return `Error: Syntax verification failed. Your proposed changes introduce syntax errors:\n${syntaxCheck.error}`;
    }

    fs.writeFileSync(targetFile, updatedContent, 'utf8');

    const diffLines: string[] = [];
    const oldLines = lines.slice(startLine - 1, endLine);
    oldLines.forEach(l => diffLines.push(`- ${l}`));
    newReplacementLines.forEach(l => diffLines.push(`+ ${l}`));

    return `Success: Patched lines ${startLine}-${endLine} in file: ${vscode.workspace.asRelativePath(targetFile)}\n\n[DIFF]\n${diffLines.join('\n')}\n\n[DIFF_PATHS]\n${tempOriginalPath}|${targetFile}`;
  }

  private static async insertFileLines(
    filePath?: string,
    lineNumberStr?: string,
    content?: string
  ): Promise<string> {
    const resolved = this.resolveWorkspacePath(filePath);
    if (!resolved.ok) return resolved.error;
    const targetFile = resolved.absolutePath;
    if (!fs.existsSync(targetFile)) {
      return `Error: File not found: ${filePath}`;
    }

    const lineNumber = parseInt(lineNumberStr || '', 10);
    if (isNaN(lineNumber) || lineNumber < 1) {
      return `Error: Invalid line number: ${lineNumberStr}`;
    }

    const fileContent = fs.readFileSync(targetFile, 'utf8');
    const lines = fileContent.split(/\r?\n/);
    const eol = fileContent.includes('\r\n') ? '\r\n' : '\n';

    // Save original for diffing
    const tempDir = os.tmpdir();
    const randomId = Math.random().toString(36).substring(7);
    const fileName = path.basename(targetFile);
    const tempOriginalPath = path.join(tempDir, `k_horizon_insert_orig_${randomId}_${fileName}`);
    fs.writeFileSync(tempOriginalPath, fileContent, 'utf8');

    const insertIdx = Math.min(lineNumber - 1, lines.length);
    const before = lines.slice(0, insertIdx);
    const after = lines.slice(insertIdx);
    const newLines = content ? content.split(/\r?\n/) : [];
    const updatedLines = [...before, ...newLines, ...after];

    const updatedContent = updatedLines.join(eol);

    // Syntax validation check
    const syntaxCheck = this.validateSyntax(targetFile, updatedContent);
    if (!syntaxCheck.ok) {
      return `Error: Syntax verification failed. Your proposed changes introduce syntax errors:\n${syntaxCheck.error}`;
    }

    fs.writeFileSync(targetFile, updatedContent, 'utf8');

    const diffLines: string[] = [];
    newLines.forEach(l => diffLines.push(`+ ${l}`));

    return `Success: Inserted content at line ${lineNumber} in file: ${vscode.workspace.asRelativePath(targetFile)}\n\n[DIFF]\n${diffLines.join('\n')}\n\n[DIFF_PATHS]\n${tempOriginalPath}|${targetFile}`;
  }

  private static async copyFile(sourcePath?: string, destinationPath?: string): Promise<string> {
    const resolvedSrc = this.resolveWorkspacePath(sourcePath, 'source_path');
    if (!resolvedSrc.ok) return resolvedSrc.error;
    const srcFile = resolvedSrc.absolutePath;
    if (!fs.existsSync(srcFile)) {
      return `Error: Source file not found: ${sourcePath}`;
    }

    const resolvedDst = this.resolveWorkspacePath(destinationPath, 'destination_path');
    if (!resolvedDst.ok) return resolvedDst.error;
    const dstFile = resolvedDst.absolutePath;

    const parentDir = path.dirname(dstFile);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.copyFileSync(srcFile, dstFile);
    return `Success: Copied file from ${vscode.workspace.asRelativePath(srcFile)} to ${vscode.workspace.asRelativePath(dstFile)}`;
  }

  private static async moveFile(sourcePath?: string, destinationPath?: string): Promise<string> {
    const resolvedSrc = this.resolveWorkspacePath(sourcePath, 'source_path');
    if (!resolvedSrc.ok) return resolvedSrc.error;
    const srcFile = resolvedSrc.absolutePath;
    if (!fs.existsSync(srcFile)) {
      return `Error: Source file not found: ${sourcePath}`;
    }

    const resolvedDst = this.resolveWorkspacePath(destinationPath, 'destination_path');
    if (!resolvedDst.ok) return resolvedDst.error;
    const dstFile = resolvedDst.absolutePath;

    const parentDir = path.dirname(dstFile);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.renameSync(srcFile, dstFile);
    return `Success: Moved/Renamed file from ${vscode.workspace.asRelativePath(srcFile)} to ${vscode.workspace.asRelativePath(dstFile)}`;
  }

  private static async executeDynamicTool(name: string, args: Record<string, any>): Promise<string> {
    const dir = this.getDynamicToolsDir();
    const jsPath = path.join(dir, `${name}.js`);
    if (!fs.existsSync(jsPath)) {
      return `Error: Dynamic tool implementation file not found for "${name}"`;
    }
    try {
      const req = eval('require');
      delete req.cache[req.resolve(jsPath)];
      const module = req(jsPath);
      if (typeof module.run !== 'function') {
        return `Error: Dynamic tool "${name}" does not export a "run(args)" function.`;
      }
      const result = await module.run(args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (e: any) {
      return `Error executing dynamic tool "${name}": ${e.message}`;
    }
  }

  private static async synthesizeCustomTool(
    toolName?: string,
    description?: string,
    requiredArgsJSON?: string,
    propertiesJSON?: string,
    code?: string
  ): Promise<string> {
    if (!toolName || !description || !requiredArgsJSON || !propertiesJSON || !code) {
      return 'Error: Missing required arguments for synthesize_custom_tool';
    }

    if (!/^[a-z0-9_]+$/.test(toolName)) {
      return 'Error: tool_name must be in snake_case (lowercase, numbers, underscores only)';
    }

    let required: string[];
    let properties: Record<string, { type: string; description: string }>;
    try {
      required = JSON.parse(requiredArgsJSON);
      if (!Array.isArray(required)) throw new Error('required_args_json must be an array of strings');
    } catch (e: any) {
      return `Error parsing required_args_json: ${e.message}`;
    }

    try {
      properties = JSON.parse(propertiesJSON);
      if (typeof properties !== 'object' || Array.isArray(properties)) {
        throw new Error('properties_json must be a JSON object');
      }
    } catch (e: any) {
      return `Error parsing properties_json: ${e.message}`;
    }

    const dir = this.getDynamicToolsDir();
    const schemaPath = path.join(dir, `${toolName}.json`);
    const jsPath = path.join(dir, `${toolName}.js`);

    const schema: ToolSchemaSpec = {
      description,
      required,
      properties
    };

    try {
      fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2), 'utf8');
      fs.writeFileSync(jsPath, code, 'utf8');
      return `Success: Synthesized and registered dynamic tool "${toolName}". It is now immediately available to call.`;
    } catch (e: any) {
      return `Error writing dynamic tool files: ${e.message}`;
    }
  }

  private static async runSpeculativePatch(
    filePath?: string,
    targetContent?: string,
    replacementContent?: string,
    validationCommand?: string
  ): Promise<string> {
    if (!filePath || targetContent === undefined || replacementContent === undefined || !validationCommand) {
      return 'Error: Missing required arguments for run_speculative_patch';
    }

    const resolved = this.resolveWorkspacePath(filePath);
    if (!resolved.ok) return resolved.error;
    const targetFile = resolved.absolutePath;
    if (!fs.existsSync(targetFile)) {
      return `Error: File not found: ${filePath}`;
    }

    const originalContent = fs.readFileSync(targetFile, 'utf8');
    const editResult = this.applyFlexibleReplacement(originalContent, targetContent, replacementContent);
    if (!editResult) {
      return `Error: Speculative patch failed. Target content not found in file: ${filePath}`;
    }

    try {
      fs.writeFileSync(targetFile, editResult.content, 'utf8');
    } catch (e: any) {
      return `Error writing patch to file: ${e.message}`;
    }

    try {
      const validationOutput = await this.runCommand(validationCommand);
      
      const failedFlagMatch = validationOutput.match(/\[FAILED:\s*(true|false)\]/);
      const failed = failedFlagMatch 
        ? failedFlagMatch[1] === 'true' 
        : (validationOutput.includes('[COMMAND FAILED]') || validationOutput.includes('[COMMAND TIMEOUT]'));

      if (failed) {
        fs.writeFileSync(targetFile, originalContent, 'utf8');
        return `Speculative patch validation failed. Rolled back changes to original state.\nCommand output:\n${validationOutput}`;
      }

      return `Success: Speculative patch validated successfully. Kept changes.\nCommand output:\n${validationOutput}`;
    } catch (e: any) {
      fs.writeFileSync(targetFile, originalContent, 'utf8');
      return `Error running validation command, rolled back changes: ${e.message}`;
    }
  }

  private static async capturePageScreenshot(
    url?: string,
    widthStr = '1280',
    heightStr = '800'
  ): Promise<string> {
    if (!url) return 'Error: url argument is missing';
    const allow = await vscode.window.showInformationMessage(
      `K-Horizon wants to perform a visual verification by taking a screenshot of ${url}. Allow?`,
      'Yes, Allow',
      'No, Deny'
    );
    if (allow !== 'Yes, Allow') {
      return 'Error: Visual verification screenshot denied by user.';
    }

    await this.acquireBrowserSlot();
    let browser: any;
    try {
      let playwright;
      try {
        playwright = require('playwright-core');
      } catch (err: any) {
        return `Error: playwright-core dependency is missing (Actual error: ${err.message || err})`;
      }

      const executablePath = this.findSystemBrowser();
      if (!executablePath) {
        return 'Error: No system Chrome/Edge browser found for screenshot capture';
      }

      browser = await playwright.chromium.launch({
        executablePath,
        headless: true
      });

      const width = parseInt(widthStr) || 1280;
      const height = parseInt(heightStr) || 800;

      const context = await browser.newContext({
        viewport: { width, height },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      });

      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });

      try {
        vscode.commands.executeCommand('simpleBrowser.show', url);
      } catch (err) {
        // Ignore if simple browser is not available
      }

      const workspaceRoot = getWorkspaceRoot();
      const screenshotsDir = path.join(workspaceRoot, '.k-horizon', 'screenshots');
      if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir, { recursive: true });
      }

      const screenshotName = `screenshot_${Date.now()}.png`;
      const screenshotPath = path.join(screenshotsDir, screenshotName);

      await page.screenshot({ path: screenshotPath });

      let analysis = '';
      try {
        const base64Image = fs.readFileSync(screenshotPath).toString('base64');
        analysis = await AIService.analyzeImage(
          base64Image,
          'image/png',
          'Describe what is visible in this web page screenshot in detail, including layout, text, buttons, inputs, and structure.'
        );
      } catch (err: any) {
        analysis = `Failed to analyze screenshot: ${err.message}`;
      }

      return `Success: Captured screenshot of ${url} at ${width}x${height}. Saved to: .k-horizon/screenshots/${screenshotName}\n\n[Vision Analysis]:\n${analysis}`;
    } catch (e: any) {
      return `Error capturing screenshot: ${e.message}`;
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (closeErr) {
          // Ignore close errors
        }
      }
      this.releaseBrowserSlot();
    }
  }

  private static async runSpeculativeWorkspacePatch(
    patchesJSON?: string,
    validationCommand?: string
  ): Promise<string> {
    if (!patchesJSON || !validationCommand) {
      return 'Error: Missing required arguments for run_speculative_workspace_patch';
    }

    let patches: Array<{ file_path: string; target_content: string; replacement_content: string }>;
    try {
      patches = JSON.parse(patchesJSON);
      if (!Array.isArray(patches)) throw new Error('patches_json must be an array of objects');
    } catch (e: any) {
      return `Error parsing patches_json: ${e.message}`;
    }

    const originalContents: Record<string, string> = {};
    for (const patch of patches) {
      const resolved = this.resolveWorkspacePath(patch.file_path);
      if (!resolved.ok) return resolved.error;
      const fileAbs = resolved.absolutePath;
      if (!fs.existsSync(fileAbs)) {
        return `Error: File not found: ${patch.file_path}`;
      }
      originalContents[fileAbs] = fs.readFileSync(fileAbs, 'utf8');
    }

    const modifiedContents: Record<string, string> = {};
    for (const patch of patches) {
      const resolved = this.resolveWorkspacePath(patch.file_path);
      if (!resolved.ok) return resolved.error;
      const fileAbs = resolved.absolutePath;
      
      const currentContent = modifiedContents[fileAbs] !== undefined 
        ? modifiedContents[fileAbs] 
        : originalContents[fileAbs];
        
      const editResult = this.applyFlexibleReplacement(currentContent, patch.target_content, patch.replacement_content);
      if (!editResult) {
        // Restore any changes already written or held
        return `Error: Speculative patch failed for file: ${patch.file_path}. Target content not found.`;
      }
      modifiedContents[fileAbs] = editResult.content;
    }

    // Write modified contents to disk
    try {
      for (const [fileAbs, content] of Object.entries(modifiedContents)) {
        fs.writeFileSync(fileAbs, content, 'utf8');
      }
    } catch (e: any) {
      // Revert disk writes on failure
      for (const [fileAbs, content] of Object.entries(originalContents)) {
        try { fs.writeFileSync(fileAbs, content, 'utf8'); } catch {}
      }
      return `Error writing speculative patches to disk: ${e.message}`;
    }

    try {
      const validationOutput = await this.runCommand(validationCommand);
      const failedFlagMatch = validationOutput.match(/\[FAILED:\s*(true|false)\]/);
      const failed = failedFlagMatch 
        ? failedFlagMatch[1] === 'true' 
        : (validationOutput.includes('[COMMAND FAILED]') || validationOutput.includes('[COMMAND TIMEOUT]'));

      if (failed) {
        // Validation failed, restore all files to original content
        for (const [fileAbs, content] of Object.entries(originalContents)) {
          fs.writeFileSync(fileAbs, content, 'utf8');
        }
        return `Speculative workspace patch validation failed. Reverted all changes.\nCommand output:\n${validationOutput}`;
      }

      return `Success: Speculative workspace patches validated successfully. Kept changes.\nCommand output:\n${validationOutput}`;
    } catch (e: any) {
      // Restore files on error
      for (const [fileAbs, content] of Object.entries(originalContents)) {
        try { fs.writeFileSync(fileAbs, content, 'utf8'); } catch {}
      }
      return `Error running validation command, rolled back changes: ${e.message}`;
    }
  }

  private static async updateDependencyGraph(): Promise<string> {
    const workspaceRoot = getWorkspaceRoot();
    const graphPath = path.join(workspaceRoot, '.k-horizon', 'ast-graph.json');
    const graph: Record<string, string[]> = {};

    const scanDir = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', '.git', 'dist', 'out', 'build', '.next'].includes(entry.name)) continue;
          scanDir(fullPath);
        } else if (entry.isFile() && /\.(js|ts|jsx|tsx|py|go|rs|java)$/i.test(entry.name)) {
          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const astResult = ASTParser.parse(fullPath, content);
            const imports = astResult.relations
              .filter(r => r.relationType === 'IMPORTS')
              .map(r => r.targetName);
            const relativePath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
            graph[relativePath] = imports;
          } catch (e) {
            // Ignore unreadable files
          }
        }
      }
    };

    try {
      scanDir(workspaceRoot);
      const dir = path.dirname(graphPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2), 'utf8');
      return `Success: Updated dependency graph. Analyzed ${Object.keys(graph).length} files. Saved to: .k-horizon/ast-graph.json`;
    } catch (e: any) {
      return `Error updating dependency graph: ${e.message}`;
    }
  }

  private static async requestHunkReviews(diffsJSON?: string): Promise<string> {
    if (!diffsJSON) return 'Error: diffs_json is required';
    try {
      const files = JSON.parse(diffsJSON);
      if (!Array.isArray(files)) throw new Error('diffs_json must be an array');

      const acceptedPatches: Array<{ file_path: string; target: string; replacement: string }> = [];
      const rejectedPatches: Array<{ file_path: string; target: string; description: string }> = [];

      for (const file of files) {
        const filePath = file.file_path;
        const hunks = file.hunks || [];

        for (let i = 0; i < hunks.length; i++) {
          const hunk = hunks[i];
          const target = hunk.target;
          const replacement = hunk.replacement;
          const desc = hunk.description || `Hunk ${i + 1}`;

          const options = ['Approve Hunk', 'Reject Hunk'];
          const choice = await vscode.window.showQuickPick(options, {
            title: `Review Hunk: ${desc} in ${filePath}`,
            placeHolder: `Target:\n${target}\n\nReplacement:\n${replacement}`,
            ignoreFocusOut: true,
          });

          if (choice === 'Approve Hunk' || !choice) {
            acceptedPatches.push({ file_path: filePath, target, replacement });
          } else {
            rejectedPatches.push({ file_path: filePath, target, description: desc });
          }
        }
      }

      for (const patch of acceptedPatches) {
        const resolved = this.resolveWorkspacePath(patch.file_path);
        if (resolved.ok) {
          const original = fs.readFileSync(resolved.absolutePath, 'utf8');
          const edited = this.applyFlexibleReplacement(original, patch.target, patch.replacement);
          if (edited) {
            fs.writeFileSync(resolved.absolutePath, edited.content, 'utf8');
          }
        }
      }

      return JSON.stringify({
        status: 'success',
        acceptedCount: acceptedPatches.length,
        rejectedCount: rejectedPatches.length,
        rejectedList: rejectedPatches.map(p => ({ file_path: p.file_path, description: p.description }))
      });
    } catch (e: any) {
      return `Error reviewing hunks: ${e.message}`;
    }
  }

  private static async runFuzzTest(
    filePath?: string,
    exportName?: string,
    iterationsStr = '100'
  ): Promise<string> {
    if (!filePath || !exportName) {
      return 'Error: file_path and export_name are required';
    }

    const resolved = this.resolveWorkspacePath(filePath);
    if (!resolved.ok) return resolved.error;
    const targetFile = resolved.absolutePath;

    const workspaceRoot = getWorkspaceRoot();
    const fuzzDir = path.join(workspaceRoot, '.k-horizon', 'fuzz-tests');
    if (!fs.existsSync(fuzzDir)) {
      fs.mkdirSync(fuzzDir, { recursive: true });
    }

    const relativeImportPath = path.relative(fuzzDir, targetFile).replace(/\\/g, '/').replace(/\.ts$/, '').replace(/\.js$/, '');
    const iterations = parseInt(iterationsStr) || 100;

    const fuzzScript = `
const target = module.require('${relativeImportPath}');
const fn = target.${exportName};

if (typeof fn !== 'function') {
  console.log('FAIL: Export "${exportName}" is not a function');
  process.exit(1);
}

function generateRandomInput() {
  const choices = [
    () => null,
    () => undefined,
    () => NaN,
    () => Infinity,
    () => -Infinity,
    () => "",
    () => "A".repeat(10000),
    () => -1,
    () => 0,
    () => 1,
    () => 99999999999999,
    () => [],
    () => [1, null, "a", {}, []],
    () => ({}),
    () => ({ a: 1, b: null, c: { d: "nested" } }),
    () => true,
    () => false
  ];
  const idx = Math.floor(Math.random() * choices.length);
  return choices[idx]();
}

console.log('Starting fuzz test on "${exportName}" for ${iterations} iterations...');
let crashCount = 0;
for (let i = 0; i < ${iterations}; i++) {
  const arg = generateRandomInput();
  try {
    fn(arg);
  } catch (err) {
    crashCount++;
    console.log(\`CRASH found on iteration \\\${i}: Input = \\\${JSON.stringify(arg)} | Error = \\\${err.message}\\\\n\\\${err.stack}\\\\n\`);
    if (crashCount >= 5) {
      console.log('Stopping after finding 5 crashes.');
      break;
    }
  }
}

if (crashCount === 0) {
  console.log('SUCCESS: Fuzz test completed with zero unhandled crashes.');
} else {
  console.log(\`FAIL: Fuzz test completed with \\\${crashCount} unhandled crashes.\`);
}
`;

    const fuzzScriptPath = path.join(fuzzDir, `fuzz_${exportName}_\${Date.now()}.js`);
    try {
      fs.writeFileSync(fuzzScriptPath, fuzzScript, 'utf8');
      const validationOutput = await this.runCommand(`node \${fuzzScriptPath}`);
      fs.unlinkSync(fuzzScriptPath);
      return validationOutput;
    } catch (e: any) {
      return `Error running fuzz test: \${e.message}`;
    }
  }

  private static async dbQuery(query: string, paramsJson?: string): Promise<string> {
    try {
      const hasString = await DBClient.hasConnectionString();
      if (!hasString) {
        return 'Error: No database connection string configured.';
      }
      const pool = await DBClient.initialize();
      const params = paramsJson ? JSON.parse(paramsJson) : [];
      const res = await pool.query(query, params);
      return JSON.stringify(res.rows, null, 2);
    } catch (err: any) {
      return `[Database Error]: ${err.message}`;
    }
  }

  private static async dbStatus(): Promise<string> {
    try {
      const hasString = await DBClient.hasConnectionString();
      return JSON.stringify({
        hasConnectionString: hasString,
        initialized: DBClient['pool'] !== undefined && DBClient['pool'].query !== undefined
      }, null, 2);
    } catch (err: any) {
      return `Error getting status: ${err.message}`;
    }
  }

  private static async getLearningRules(): Promise<string> {
    try {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) return 'Error: No workspace open.';
      const learnings = await AgentLearningManager.loadLearnings(workspaceRoot);
      return JSON.stringify(learnings, null, 2);
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  private static async findLearningRules(query?: string): Promise<string> {
    try {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) return 'Error: No workspace open.';
      const matches = await AgentLearningManager.findMatchingLearnings(workspaceRoot, query || '');
      return JSON.stringify(matches, null, 2);
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  private static async gatherFailureDiagnostics(command?: string, file_path?: string): Promise<string> {
    try {
      const workspaceRoot = getWorkspaceRoot();
      const parts: string[] = [];
      parts.push(`=== Failure Diagnostics Report ===`);
      parts.push(`Command: ${command}`);
      parts.push(`Workspace: ${workspaceRoot || 'unknown'}`);

      if (file_path) {
        parts.push(`Suspected file: ${file_path}`);
        try {
          const content = await this.readFile(file_path);
          parts.push(`--- File preview (${file_path}) ---\n${content.slice(0, 2000)}`);
        } catch {}
      }

      parts.push('\n--- Re-running failing command (capturing structured output) ---');
      if (command) {
        const cmdOut = await this.runCommand(command);
        parts.push(cmdOut);
      }

      parts.push('\n--- Live VS Code Diagnostics ---');
      const diag = await this.getDiagnostics(file_path);
      parts.push(diag);

      parts.push('\n--- Git Diff (uncommitted changes) ---');
      const diff = await this.gitDiff();
      parts.push(diff);

      return parts.join('\n\n');
    } catch (err: any) {
      return `Error gathering diagnostics: ${err.message}`;
    }
  }

  private static async addLearningRule(mistake: string, correction: string, source?: string): Promise<string> {
    try {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) return 'Error: No workspace open.';
      const learning = await AgentLearningManager.saveLearning(workspaceRoot, {
        mistake,
        correction,
        source: (source === 'self_correction' ? 'self_correction' : 'user_correction')
      });
      return JSON.stringify(learning, null, 2);
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  private static async deleteLearningRule(ruleId: string): Promise<string> {
    try {
      const workspaceRoot = getWorkspaceRoot();
      if (!workspaceRoot) return 'Error: No workspace open.';
      await AgentLearningManager.deleteLearning(workspaceRoot, ruleId);
      return `Successfully deleted learning rule ${ruleId}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  private static async getVscodeSettings(key?: string): Promise<string> {
    try {
      const config = vscode.workspace.getConfiguration('k-horizon');
      if (key) {
        const val = config.get(key);
        return JSON.stringify({ [key]: val }, null, 2);
      }
      
      const keys = [
        'provider', 'apiKey', 'stitchApiKey', 'baseURL', 'chatModel',
        'plannerModel', 'coderModel', 'autocompleteModel', 'visionModel', 'enableAutocomplete',
        'enableContinuousLearning', 'maxContextTokens', 'systemPrompt',
        'supabaseConnectionString', 'sandboxMode', 'firecrawlApiKey',
        'firecrawlBaseUrl', 'aicreditsApiKey', 'customModels'
      ];
      const result: Record<string, any> = {};
      for (const k of keys) {
        result[k] = config.get(k);
      }
      return JSON.stringify(result, null, 2);
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  private static async updateVscodeSettings(key: string, valueJson: string): Promise<string> {
    try {
      const config = vscode.workspace.getConfiguration('k-horizon');
      const val = JSON.parse(valueJson);
      await config.update(key, val, vscode.ConfigurationTarget.Global);
      return `Successfully updated config key "k-horizon.${key}" to ${JSON.stringify(val)}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  private static async toggleAutocomplete(enabled: string): Promise<string> {
    try {
      const isEnabled = enabled === 'true';
      const config = vscode.workspace.getConfiguration('k-horizon');
      await config.update('enableAutocomplete', isEnabled, vscode.ConfigurationTarget.Global);
      return `Successfully toggled autocomplete to ${isEnabled}`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  private static validateSyntax(filePath: string, content: string): { ok: boolean; error?: string } {
    const ext = path.extname(filePath).toLowerCase();
    
    if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') {
      try {
        const sourceFile = ts.createSourceFile(
          filePath,
          content,
          ts.ScriptTarget.Latest,
          true
        );
        const sf = sourceFile as any;
        if (sf.parseDiagnostics && sf.parseDiagnostics.length > 0) {
          const errors = sf.parseDiagnostics
            .map((d: any) => {
              const { line, character } = sourceFile.getLineAndCharacterOfPosition(d.start || 0);
              const message = typeof d.messageText === 'string' 
                ? d.messageText 
                : ts.flattenDiagnosticMessageText(d.messageText, '\n');
              return `Line ${line + 1}, Col ${character + 1}: ${message}`;
            })
            .join('\n');
          return { ok: false, error: errors };
        }
      } catch (err: any) {
        return { ok: false, error: `TS/JS AST parsing failed: ${err.message}` };
      }
    }
    
    if (ext === '.py' || ext === '.go' || ext === '.rs' || ext === '.java') {
      const openBraces = (content.match(/\{/g) || []).length;
      const closeBraces = (content.match(/\}/g) || []).length;
      if (openBraces !== closeBraces) {
        return { 
          ok: false, 
          error: `Brace mismatch: Found ${openBraces} open braces '{' and ${closeBraces} close braces '}'.` 
        };
      }
      const openParens = (content.match(/\(/g) || []).length;
      const closeParens = (content.match(/\)/g) || []).length;
      if (openParens !== closeParens) {
        return { 
          ok: false, 
          error: `Parenthesis mismatch: Found ${openParens} open parentheses '(' and ${closeParens} close parentheses ')'.` 
        };
      }
    }

    return { ok: true };
  }
}
