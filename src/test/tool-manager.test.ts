import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolManager } from '../tool-manager';
import { MCPManager } from '../mcp-manager';
import { __setWorkspaceRoot, workspace } from './vscode-mock';
import { parseCommandFailure } from '../npm-error-parser';
import { AIService } from '../ai-service';
import { DBClient } from '../db-client';

const tempDirs: string[] = [];

function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'k-horizon-test-'));
  tempDirs.push(dir);
  __setWorkspaceRoot(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('ToolManager.edit_file failure message is self-describing', () => {
  it('returns actual file content near the closest match when target is missing', async () => {
    const workspace = makeTempWorkspace();
    const targetFile = path.join(workspace, 'src', 'sample.ts');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    const originalContent = [
      'export const x = 1;',
      '',
      'export function foo() {',
      '  return 42;',
      '}',
      '',
      'export const y = 2;',
    ].join('\n');
    fs.writeFileSync(targetFile, originalContent, 'utf8');

    const result = await ToolManager.execute('edit_file', {
      file_path: 'src/sample.ts',
      target_content: 'export const x = 99;', // wrong — file has `x = 1`
      replacement_content: 'export const x = 100;',
    });

    expect(result).toContain('Error:');
    expect(result).toContain('Target content to replace was not found');
    // Self-describing: should include the actual line near the closest match
    expect(result).toContain('export const x = 1;');
    expect(result).toContain('Fix hint:');
    // Should reference the read_file tool to encourage the model to re-read
    expect(result).toContain('read_file');
  });
});

describe('ToolManager.verify_edit', () => {
  it('reads the file back from disk and includes diagnostics section', async () => {
    const workspace = makeTempWorkspace();
    const targetFile = path.join(workspace, 'verify.ts');
    fs.writeFileSync(targetFile, 'export const z = 3;\n', 'utf8');

    const result = await ToolManager.execute('verify_edit', { file_path: 'verify.ts' });

    expect(result).toContain('Verification for verify.ts');
    expect(result).toContain('export const z = 3;');
    expect(result).toContain('Diagnostics:');
  });

  it('returns an error when the file does not exist', async () => {
    makeTempWorkspace();
    const result = await ToolManager.execute('verify_edit', { file_path: 'missing.ts' });
    expect(result).toContain('File not found');
  });

  it('returns an error when file_path is missing', async () => {
    makeTempWorkspace();
    const result = await ToolManager.execute('verify_edit', {});
    expect(result).toContain('requires argument "file_path"');
  });
});

describe('ToolManager.parseToolCalls', () => {
  it('parses multiline XML tool calls without losing content whitespace', () => {
    const calls = ToolManager.parseToolCalls(`<tool_call name="write_file">
  <file_path>src/example.ts</file_path>
  <content>export function demo() {
  return "<tag-like text>";
}
</content>
</tool_call>`);

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('write_file');
    expect(calls[0].arguments.file_path).toBe('src/example.ts');
    expect(calls[0].arguments.content).toContain('return "<tag-like text>";');
  });

  it('parses direct tool tags as the XML fallback format', () => {
    const calls = ToolManager.parseToolCalls(`<run_command>
  <command>npm test</command>
  <timeout_ms>120000</timeout_ms>
</run_command>`);

    expect(calls).toEqual([
      {
        name: 'run_command',
        arguments: {
          command: 'npm test',
          timeout_ms: '120000',
        },
      },
    ]);
  });

  it('parses direct tags for newly supported tools like delete_file', () => {
    const calls = ToolManager.parseToolCalls(`<delete_file>
  <file_path>src/old.ts</file_path>
</delete_file>`);

    expect(calls).toEqual([
      {
        name: 'delete_file',
        arguments: {
          file_path: 'src/old.ts',
        },
      },
    ]);
  });

  it('strips python_tag, tool_call, and extracts JSON tool calls with scoring', () => {
    const text = `
Here is my thinking: I need to write a file.
<|python_tag|>
<|tool_call|>
<tool_call>
{
  "name": "write_file",
  "arguments": {
    "file_path": "src/test.ts",
    "content": "hello"
  }
}
</tool_call>
Some trailing explanation.
    `;
    const calls = ToolManager.parseToolCalls(text);
    expect(calls).toEqual([
      {
        name: 'write_file',
        arguments: {
          file_path: 'src/test.ts',
          content: 'hello'
        }
      }
    ]);
  });

  it('prefers valid known tool call candidates over generic JSON blocks', () => {
    const text = `
First, some explanation with JSON block:
{
  "analysis": "I will edit the file to fix compilation error",
  "name": "not_a_real_tool_name"
}
Now, the actual tool call:
{
  "name": "edit_file",
  "arguments": {
    "file_path": "src/index.ts",
    "target_content": "old",
    "replacement_content": "new"
  }
}
    `;
    const calls = ToolManager.parseToolCalls(text);
    expect(calls).toEqual([
      {
        name: 'edit_file',
        arguments: {
          file_path: 'src/index.ts',
          target_content: 'old',
          replacement_content: 'new'
        }
      }
    ]);
  });

  it('does not parse generic JSON objects with name (like package.json) as tool calls if they are not known tools and lack arguments keys', () => {
    const text = `
Here is a package.json content:
{
  "name": "restaurant-landing",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "react": "^18.0.0"
  }
}
    `;
    const calls = ToolManager.parseToolCalls(text);
    expect(calls).toEqual([]);
  });
});

describe('ToolManager.resolveToolName', () => {
  it('resolves built-in tool names directly', () => {
    expect(ToolManager.resolveToolName('read_file')).toBe('read_file');
    expect(ToolManager.resolveToolName('write_file')).toBe('write_file');
  });

  it('fuzzy resolves built-in tool names with case/formatting mismatches', () => {
    expect(ToolManager.resolveToolName('ReadFile')).toBe('read_file');
    expect(ToolManager.resolveToolName('READ_FILE')).toBe('read_file');
    expect(ToolManager.resolveToolName('write-file')).toBe('write_file');
  });

  it('resolves prefix-less MCP tool names fuzzy-matching available MCP tools', () => {
    const originalGetAllTools = MCPManager.getAllTools;
    MCPManager.getAllTools = () => [
      { name: 'read_file', serverName: 'Filesystem', inputSchema: { type: 'object', properties: {} }, description: '' },
      { name: 'create_entities', serverName: 'Memory', inputSchema: { type: 'object', properties: {} }, description: '' }
    ];

    try {
      expect(ToolManager.resolveToolName('create_entities')).toBe('mcp__Memory__create_entities');
      expect(ToolManager.resolveToolName('mcp__Filesystem__read_file')).toBe('mcp__Filesystem__read_file');
      expect(ToolManager.resolveToolName('Memory_create_entities')).toBe('mcp__Memory__create_entities');
      expect(ToolManager.resolveToolName('createEntities')).toBe('mcp__Memory__create_entities');
    } finally {
      MCPManager.getAllTools = originalGetAllTools;
    }
  });

  it('returns null for completely unknown tools', () => {
    expect(ToolManager.resolveToolName('not_a_real_tool')).toBeNull();
  });
});

describe('ToolManager.applyPlaceholderReplacement', () => {
  it('replaces content between matched segments separated by placeholder comments', () => {
    const original = 'class Calculator {\n  add(a, b) {\n    return a + b;\n  }\n  sub(a, b) {\n    return a - b;\n  }\n}';
    const target = 'class Calculator {\n  // ...\n  sub(a, b) {\n    return a - b;\n  }\n}';
    const replacement = 'class Calculator {\n  add(a, b) {\n    return a + b;\n  }\n  multiply(a, b) {\n    return a * b;\n  }\n  sub(a, b) {\n    return a - b;\n  }\n}';
    
    const res = ToolManager.applyPlaceholderReplacement(original, target, replacement);
    expect(res).not.toBeNull();
    expect(res?.content).toContain('multiply');
    expect(res?.strategy).toBe('placeholder-span-replacement');
  });

  it('tolerates minor whitespace variations around placeholders', () => {
    const original = 'function test() {\n  console.log("hello");\n  console.log("world");\n}';
    const target = 'function test() {\n  ...\n  console.log("world");\n}';
    const replacement = 'function test() {\n  console.log("hello");\n  console.log("there");\n  console.log("world");\n}';

    const res = ToolManager.applyPlaceholderReplacement(original, target, replacement);
    expect(res).not.toBeNull();
    expect(res?.content).toContain('there');
  });
});

describe('ToolManager flat JSON tool calls', () => {
  it('extracts arguments defined at the root level of JSON objects', () => {
    const jsonInput = {
      name: 'read_file',
      file_path: 'src/main.ts'
    };
    const normalized = (ToolManager as any).normalizeJsonToolCalls(jsonInput);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].name).toBe('read_file');
    expect(normalized[0].arguments).toEqual({ file_path: 'src/main.ts' });
  });
});

describe('ToolManager MCP type coercion', () => {
  it('coerces string values to numbers or booleans matching MCP schemas', () => {
    const originalGetAllTools = MCPManager.getAllTools;
    MCPManager.getAllTools = () => [
      {
        name: 'set_page_limit',
        serverName: 'Database',
        description: 'Set limit',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number' },
            active: { type: 'boolean' },
            name: { type: 'string' }
          }
        }
      }
    ];

    try {
      const coerced = (ToolManager as any).normalizeToolArguments('mcp__Database__set_page_limit', {
        limit: '50',
        active: 'true',
        name: 'test'
      });
      expect(coerced.limit).toBe(50);
      expect(coerced.active).toBe(true);
      expect(coerced.name).toBe('test');
    } finally {
      MCPManager.getAllTools = originalGetAllTools;
    }
  });
});

describe('ToolManager native tool calls', () => {
  it('normalizes provider-native JSON arguments for execution', () => {
    const calls = ToolManager.normalizeNativeToolCalls([
      {
        function: {
          name: 'edit_file',
          arguments: JSON.stringify({
            file_path: 'src/a.ts',
            target_content: 'old',
            replacement_content: 'new',
            timeout_ms: 1000,
          }),
        },
      },
    ]);

    expect(calls).toEqual([
      {
        name: 'edit_file',
        arguments: {
          file_path: 'src/a.ts',
          target_content: 'old',
          replacement_content: 'new',
          timeout_ms: '1000',
        },
      },
    ]);
  });

  it('exposes real JSON schemas for OpenAI-compatible providers', () => {
    const definitions = ToolManager.getNativeToolDefinitions('openai');
    const writeFile = definitions.find(def => def.function?.name === 'write_file');

    expect(writeFile?.type).toBe('function');
    expect(writeFile?.function.parameters.required).toEqual(['file_path', 'content']);
    expect(writeFile?.function.parameters.properties.content.type).toBe('string');
  });
});

describe('ToolManager path sandboxing', () => {
  it('blocks file access outside the active workspace', async () => {
    const workspace = makeTempWorkspace();
    const outsideFile = path.join(os.tmpdir(), `k-horizon-outside-${Date.now()}.txt`);
    fs.writeFileSync(outsideFile, 'secret', 'utf8');

    try {
      const result = await ToolManager.execute('read_file', {
        file_path: path.relative(workspace, outsideFile),
      });
      expect(result).toContain('Refusing to access path outside the workspace');
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });
});

describe('ToolManager dangerous command blocking', () => {
  it('refuses high-risk destructive commands before shell execution', async () => {
    const result = await ToolManager.execute('run_command', {
      command: 'git reset --hard HEAD',
    });

    expect(result).toContain('Refusing to run a high-risk destructive command');
  });
});

describe('ToolManager.applyFlexibleReplacement', () => {
  it('replaces blocks with normalized newlines', () => {
    const result = ToolManager.applyFlexibleReplacement(
      'a\r\nb\r\nc\r\n',
      'b\nc',
      'B\nC'
    );

    expect(result?.strategy).toBe('newline-normalized');
    expect(result?.content).toBe('a\r\nB\r\nC\r\n');
  });

  it('matches lines despite leading and trailing whitespace drift', () => {
    const result = ToolManager.applyFlexibleReplacement(
      'function x() {\n    return 1;   \n}\n',
      'return 1;',
      'return 2;'
    );

    expect(result?.strategy).toBe('line-whitespace-tolerant-trimmed');
    expect(result?.content).toBe('function x() {\nreturn 2;\n}\n');
  });
});

describe('ToolManager.htmlToMarkdown', () => {
  it('preserves link URLs', () => {
    const md = ToolManager.htmlToMarkdown(
      '<html><body><p>See <a href="https://example.com">example</a>.</p></body></html>'
    );
    expect(md).toContain('[example](https://example.com)');
  });

  it('preserves fenced code blocks', () => {
    const md = ToolManager.htmlToMarkdown(
      '<html><body><pre><code class="language-ts">const x = 1;</code></pre></body></html>'
    );
    expect(md).toContain('```ts');
    expect(md).toContain('const x = 1;');
    expect(md).toContain('```');
  });

  it('preserves inline code', () => {
    const md = ToolManager.htmlToMarkdown(
      '<html><body><p>Use <code>npm install</code> first.</p></body></html>'
    );
    expect(md).toContain('`npm install`');
  });

  it('converts tables to pipe-table markdown', () => {
    const md = ToolManager.htmlToMarkdown(
      '<html><body><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>'
    );
    expect(md).toContain('| A | B |');
    expect(md).toContain('| --- | --- |');
    expect(md).toContain('| 1 | 2 |');
  });

  it('strips script and style content', () => {
    const md = ToolManager.htmlToMarkdown(
      '<html><body><p>visible</p><script>alert(1)</script><style>p{}</style><p>also visible</p></body></html>'
    );
    expect(md).not.toContain('alert(1)');
    expect(md).not.toContain('p{}');
    expect(md).toContain('visible');
    expect(md).toContain('also visible');
  });

  it('strips header/nav/footer when a main region exists', () => {
    const md = ToolManager.htmlToMarkdown(
      '<html><body><header>site nav links</header><main><p>main content</p></main><footer>copyright</footer></body></html>'
    );
    expect(md).toContain('main content');
    expect(md).not.toContain('site nav links');
    expect(md).not.toContain('copyright');
  });

  it('keeps header content when there is no main region', () => {
    const md = ToolManager.htmlToMarkdown(
      '<html><body><header><p>only content here</p></header></body></html>'
    );
    expect(md).toContain('only content here');
  });

  it('preserves image alt text as markdown link', () => {
    const md = ToolManager.htmlToMarkdown(
      '<html><body><img alt="logo" src="/img/logo.png"/></body></html>'
    );
    expect(md).toContain('![logo](/img/logo.png)');
  });
});

describe('ToolManager.truncateForModel', () => {
  it('returns input unchanged when under the cap', () => {
    const input = 'x'.repeat(100);
    expect(ToolManager.truncateForModel(input)).toBe(input);
  });

  it('returns head+tail when over the cap with a truncation marker', () => {
    // Build an input that is unambiguously larger than FETCH_MAX_CHARS (12000).
    const head = 'H'.repeat(6000);
    const middle = 'M'.repeat(5000);
    const tail = 'T'.repeat(6000);
    const input = head + middle + tail; // 17000 chars

    const out = ToolManager.truncateForModel(input);

    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
    expect(out).toContain('[TRUNCATED');
    expect(out).toContain('5000 MIDDLE CHARACTERS OF 17000-CHAR PAGE');
    // The middle filler should NOT survive.
    expect(out).not.toContain('M'.repeat(100));
  });
});

describe('ToolManager.edit_file with fuzzy and search-replace block support', () => {
  it('supports fuzzy line window matching when exact match fails', async () => {
    const workspace = makeTempWorkspace();
    const targetFile = path.join(workspace, 'sample.ts');
    const originalContent = [
      'export function greet(name: string) {',
      '  console.log("Hello, " + name);',
      '  const active = true;',
      '  const status = "ok";',
      '  return flag;',
      '}',
    ].join('\n');
    fs.writeFileSync(targetFile, originalContent, 'utf8');

    // We pass 3 exact lines and 1 slightly different line
    const result = await ToolManager.execute('edit_file', {
      file_path: 'sample.ts',
      target_content: '  console.log("Hello, " + name);\n  const active = true;\n  const status = "ok";\n  return true;',
      replacement_content: '  console.log(`Hello, ${name}!`);\n  const active = true;\n  const status = "online";\n  return false;',
    });

    expect(result).toContain('Success:');
    expect(result).toContain('fuzzy-line-window');
    
    const updated = fs.readFileSync(targetFile, 'utf8');
    expect(updated).toContain('console.log(`Hello, ${name}!`);');
    expect(updated).toContain('const status = "online";');
    expect(updated).toContain('return false;');
  });

  it('supports search-replace blocks formatting inside target_content', async () => {
    const workspace = makeTempWorkspace();
    const targetFile = path.join(workspace, 'sample.ts');
    const originalContent = [
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
    ].join('\n');
    fs.writeFileSync(targetFile, originalContent, 'utf8');

    const searchReplaceBlock = [
      '<<<<<<< SEARCH',
      'const a = 1;',
      '=======',
      'const a = 100;',
      '>>>>>>> REPLACE',
      '<<<<<<< SEARCH',
      'const c = 3;',
      '=======',
      'const c = 300;',
      '>>>>>>> REPLACE',
    ].join('\n');

    const result = await ToolManager.execute('edit_file', {
      file_path: 'sample.ts',
      target_content: searchReplaceBlock,
      replacement_content: '', // empty is fine since block has replacements
    });

    expect(result).toContain('Success:');
    expect(result).toContain('search-replace-blocks');

    const updated = fs.readFileSync(targetFile, 'utf8');
    expect(updated).toContain('const a = 100;');
    expect(updated).toContain('const b = 2;');
    expect(updated).toContain('const c = 300;');
  });
});

describe('npm-error-parser command failure parsing', () => {
  it('correctly parses and preserves TS compilation errors', () => {
    const tsOutput = `
> build
> tsc

src/sidebar-provider.ts(1264,487): error TS1005: ',' expected.
src/agent-graph.ts(50,22): error TS2339: Property 'id' does not exist on type 'SubagentProfile'.
    `;
    const report = parseCommandFailure(tsOutput, '', 1, null, '/workspace');

    expect(report.failed).toBe(true);
    expect(report.category).toBe('compile');
    expect(report.npmErrorLines).toContain("src/sidebar-provider.ts(1264,487): error TS1005: ',' expected.");
    expect(report.npmErrorLines).toContain("src/agent-graph.ts(50,22): error TS2339: Property 'id' does not exist on type 'SubagentProfile'.");
    expect(report.curatedExcerpt).toContain("src/sidebar-provider.ts(1264,487): error TS1005: ',' expected.");
  });

  it('correctly parses and preserves Webpack bundler errors', () => {
    const webpackOutput = `
ERROR in C:\\Users\\ramas\\OneDrive\\Desktop\\microservices\\src\\sidebar-provider.ts
./src/sidebar-provider.ts 1264:486-495
[tsl] ERROR in C:\\Users\\ramas\\OneDrive\\Desktop\\microservices\\src\\sidebar-provider.ts(1264,487)
      TS1005: ',' expected.
    `;
    const report = parseCommandFailure(webpackOutput, '', 1, null, '/workspace');

    expect(report.failed).toBe(true);
    expect(report.category).toBe('compile');
    expect(report.npmErrorLines).toContain("[tsl] ERROR in C:\\Users\\ramas\\OneDrive\\Desktop\\microservices\\src\\sidebar-provider.ts(1264,487)");
    expect(report.curatedExcerpt).toContain("ERROR in C:\\Users\\ramas\\OneDrive\\Desktop\\microservices\\src\\sidebar-provider.ts");
  });

  it('correctly parses and preserves Vitest/Jest test runner failures', () => {
    const testOutput = `
 ✗ src/test/tool-manager.test.ts (1 test failed)
   FAIL  src/test/tool-manager.test.ts > ToolManager.edit_file
   AssertionError: expected 'Error' to contain 'Success'
    `;
    const report = parseCommandFailure(testOutput, '', 1, null, '/workspace');

    expect(report.failed).toBe(true);
    expect(report.category).toBe('test-failure');
    expect(report.npmErrorLines).toContain("   FAIL  src/test/tool-manager.test.ts > ToolManager.edit_file");
    expect(report.curatedExcerpt).toContain("AssertionError: expected 'Error' to contain 'Success'");
  });
});

describe('ToolManager.database_tools', () => {
  it('db_status checks connection status', async () => {
    makeTempWorkspace();
    const origHasConn = DBClient.hasConnectionString;
    DBClient.hasConnectionString = async () => false;

    try {
      const status = await ToolManager.execute('db_status', {});
      expect(JSON.parse(status).hasConnectionString).toBe(false);
    } finally {
      DBClient.hasConnectionString = origHasConn;
    }
  });

  it('db_query executes queries with mock pool', async () => {
    makeTempWorkspace();
    const origHasConn = DBClient.hasConnectionString;
    const origInit = DBClient.initialize;

    DBClient.hasConnectionString = async () => true;
    const mockQuery = vi.fn().mockResolvedValue({ rows: [{ col: 'val' }] });
    DBClient.initialize = async () => ({
      query: mockQuery
    } as any);

    try {
      const result = await ToolManager.execute('db_query', {
        query: 'SELECT * FROM test WHERE id = $1',
        params_json: '["id1"]'
      });
      expect(mockQuery).toHaveBeenCalledWith('SELECT * FROM test WHERE id = $1', ['id1']);
      expect(JSON.parse(result)).toEqual([{ col: 'val' }]);
    } finally {
      DBClient.hasConnectionString = origHasConn;
      DBClient.initialize = origInit;
    }
  });
});

describe('ToolManager.learning_rules', () => {
  it('manages continuous learning rules', async () => {
    const workspace = makeTempWorkspace();
    
    let rules = await ToolManager.execute('get_learning_rules', {});
    expect(JSON.parse(rules)).toEqual([]);

    const added = await ToolManager.execute('add_learning_rule', {
      mistake: 'Forgot imports',
      correction: 'Import all modules',
      source: 'user_correction'
    });
    const parsedAdded = JSON.parse(added);
    expect(parsedAdded.mistake).toBe('Forgot imports');
    expect(parsedAdded.correction).toBe('Import all modules');
    expect(parsedAdded.source).toBe('user_correction');
    expect(parsedAdded.id).toBeDefined();

    rules = await ToolManager.execute('get_learning_rules', {});
    const parsedRules = JSON.parse(rules);
    expect(parsedRules).toHaveLength(1);
    expect(parsedRules[0].mistake).toBe('Forgot imports');

    const delResult = await ToolManager.execute('delete_learning_rule', {
      rule_id: parsedAdded.id
    });
    expect(delResult).toContain('Successfully deleted');

    rules = await ToolManager.execute('get_learning_rules', {});
    expect(JSON.parse(rules)).toEqual([]);
  });
});

describe('ToolManager.vscode_settings_tools', () => {
  it('reads, updates settings and toggles autocomplete', async () => {
    makeTempWorkspace();
    const configMap = new Map<string, any>();
    configMap.set('chatModel', 'gemini-1.5-flash');
    configMap.set('enableAutocomplete', true);

    const origGetConfig = workspace.getConfiguration;
    workspace.getConfiguration = () => ({
      get: (key: string) => configMap.get(key),
      update: async (key: string, value: any) => {
        configMap.set(key, value);
      }
    } as any);

    try {
      const singleSetting = await ToolManager.execute('get_vscode_settings', { key: 'chatModel' });
      expect(JSON.parse(singleSetting)).toEqual({ chatModel: 'gemini-1.5-flash' });

      const allSettings = await ToolManager.execute('get_vscode_settings', {});
      const parsedAll = JSON.parse(allSettings);
      expect(parsedAll.chatModel).toBe('gemini-1.5-flash');
      expect(parsedAll.enableAutocomplete).toBe(true);

      const updateRes = await ToolManager.execute('update_vscode_settings', {
        key: 'chatModel',
        value_json: '"gpt-4o"'
      });
      expect(updateRes).toContain('Successfully updated');
      expect(configMap.get('chatModel')).toBe('gpt-4o');

      const toggleRes = await ToolManager.execute('toggle_autocomplete', { enabled: 'false' });
      expect(toggleRes).toContain('Successfully toggled autocomplete to false');
      expect(configMap.get('enableAutocomplete')).toBe(false);
    } finally {
      workspace.getConfiguration = origGetConfig;
    }
  });
});

describe('AIService.analyzeImage', () => {
  it('sends correct image payload and parses response', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'Mocked vision description of the screenshot'
            }
          }
        ]
      })
    };
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(mockResponse as any);

    try {
      const desc = await AIService.analyzeImage(
        'dGVzdF9iYXNlNjQ=', // base64 for 'test_base64'
        'image/png',
        'Describe this image'
      );
      expect(desc).toBe('Mocked vision description of the screenshot');
      expect(global.fetch).toHaveBeenCalled();
      const [urlArg, initArg] = (global.fetch as any).mock.calls[0];
      expect(urlArg).toContain('generativelanguage.googleapis.com');
      const body = JSON.parse(initArg.body);
      expect(body.messages[0].content[0].text).toBe('Describe this image');
      expect(body.messages[0].content[1].image_url.url).toContain('data:image/png;base64,dGVzdF9iYXNlNjQ=');
    } finally {
      global.fetch = origFetch;
    }
  });

  it('resolves provider from model name when main provider is Copilot', async () => {
    const configMap = new Map<string, any>();
    configMap.set('provider', 'Copilot');
    configMap.set('visionModel', 'gpt-4o');

    const origGetConfig = workspace.getConfiguration;
    workspace.getConfiguration = () => ({
      get: (key: string) => configMap.get(key),
    } as any);

    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: 'Decoded' } }
        ]
      })
    };
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(mockResponse as any);

    try {
      const desc = await AIService.analyzeImage('base64', 'image/png', 'prompt');
      expect(desc).toBe('Decoded');
      expect(global.fetch).toHaveBeenCalled();
      const [urlArg] = (global.fetch as any).mock.calls[0];
      expect(urlArg).toContain('api.openai.com');
    } finally {
      global.fetch = origFetch;
      workspace.getConfiguration = origGetConfig;
    }
  });

  describe('commandExists and sandbox docker pre-flight check', () => {
    it('commandExists returns true for standard executable and false for non-existing', () => {
      const existsNode = ToolManager.commandExists('node');
      expect(existsNode).toBe(true);

      const existsFake = ToolManager.commandExists('fake-non-existent-executable-1234');
      expect(existsFake).toBe(false);
    });

    it('returns error message if docker is not installed when in Docker sandbox mode', async () => {
      const configMap = new Map<string, any>();
      configMap.set('sandboxMode', 'Docker');
      const origGetConfig = workspace.getConfiguration;
      workspace.getConfiguration = () => ({
        get: (key: string) => configMap.get(key),
      } as any);

      // Force commandExists('docker') to return false
      const origCommandExists = ToolManager.commandExists;
      ToolManager.commandExists = (cmd: string) => cmd === 'docker' ? false : origCommandExists(cmd);

      try {
        const workspaceDir = makeTempWorkspace();
        const res = await (ToolManager as any).runCommand('echo "test"', workspaceDir);
        expect(res).toContain('Docker is not installed or not available on your system PATH');
        expect(res).toContain('[FAILED: true]');
        expect(res).toContain('[CATEGORY: command-not-found]');
      } finally {
        ToolManager.commandExists = origCommandExists;
        workspace.getConfiguration = origGetConfig;
      }
    });
  });

  describe('ToolManager.runCommand preflight failures', () => {
    it('returns structured failure metadata when npm command has no package.json', async () => {
      const workspaceDir = makeTempWorkspace();

      const res = await (ToolManager as any).runCommand('npm run compile', workspaceDir);

      expect(res).toContain('[FAILED: true]');
      expect(res).toContain('[CATEGORY: missing-package-json]');
      expect(res).toContain('[COMMAND FAILED]');
    });

    it('returns structured failure metadata when npm script is missing', async () => {
      const workspaceDir = makeTempWorkspace();
      fs.writeFileSync(path.join(workspaceDir, 'package.json'), JSON.stringify({
        scripts: {
          test: 'vitest run'
        }
      }), 'utf8');

      const res = await (ToolManager as any).runCommand('npm run compile', workspaceDir);

      expect(res).toContain('[FAILED: true]');
      expect(res).toContain('[CATEGORY: missing-script]');
      expect(res).toContain('does not define a "compile" script');
    });

    it('returns structured failure metadata when directory is invalid', async () => {
      const workspaceDir = makeTempWorkspace();

      const res = await (ToolManager as any).runCommand('node --version', 'missing-dir');

      expect(res).toContain('[FAILED: true]');
      expect(res).toContain('[CATEGORY: enoent]');
      expect(res).toContain('Specified directory does not exist');
    });
  });

  describe('ToolManager new file tools', () => {
    it('getFileMetadata returns correct details for existing files', async () => {
      const ws = makeTempWorkspace();
      const testFile = path.join(ws, 'meta.txt');
      fs.writeFileSync(testFile, 'line1\nline2\nline3', 'utf8');

      const res = await ToolManager.execute('get_file_metadata', { file_path: 'meta.txt' });
      const meta = JSON.parse(res);
      expect(meta.type).toBe('file');
      expect(meta.line_count).toBe(3);
      expect(meta.size_bytes).toBe(17);
    });

    it('createDirectory recursively creates directories', async () => {
      const ws = makeTempWorkspace();
      const newDir = 'nested/sub/dir';
      const res = await ToolManager.execute('create_directory', { directory_path: newDir });
      expect(res).toContain('Success: Created directory');
      expect(fs.existsSync(path.join(ws, newDir))).toBe(true);
    });

    it('replaceInFiles replaces text globally in matching files', async () => {
      const ws = makeTempWorkspace();
      const file1 = path.join(ws, 'file1.txt');
      const file2 = path.join(ws, 'file2.txt');
      fs.writeFileSync(file1, 'hello world', 'utf8');
      fs.writeFileSync(file2, 'hello coding agent', 'utf8');

      const findFilesSpy = (vi.spyOn(workspace, 'findFiles') as any).mockResolvedValue([
        { fsPath: file1 } as any,
        { fsPath: file2 } as any
      ]);

      try {
        const res = await ToolManager.execute('replace_in_files', {
          query: 'hello',
          replacement: 'greetings',
          includes: '*.txt'
        });

        expect(res).toContain('Success: Replaced "hello" with "greetings" in 2 files');
        expect(fs.readFileSync(file1, 'utf8')).toBe('greetings world');
        expect(fs.readFileSync(file2, 'utf8')).toBe('greetings coding agent');
      } finally {
        findFilesSpy.mockRestore();
      }
    });
  });

  describe('ToolManager argument normalization', () => {
    it('normalizes native tool call arguments (camelCase and semantic overrides)', () => {
      const rawCalls = [
        {
          name: 'edit_file',
          arguments: {
            filePath: 'src/main.ts',
            target: 'old code',
            replace: 'new code'
          }
        }
      ];
      const normalized = ToolManager.normalizeNativeToolCalls(rawCalls);
      expect(normalized).toHaveLength(1);
      expect(normalized[0].arguments.file_path).toBe('src/main.ts');
      expect(normalized[0].arguments.target_content).toBe('old code');
      expect(normalized[0].arguments.replacement_content).toBe('new code');
    });

    it('normalizes parsed JSON tool call arguments', () => {
      const text = `\`\`\`json
{
  "name": "edit_file",
  "arguments": {
    "filePath": "src/app.ts",
    "target": "const a = 1;",
    "replacement": "const a = 2;"
  }
}
\`\`\``;
      const calls = ToolManager.parseToolCalls(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('edit_file');
      expect(calls[0].arguments.file_path).toBe('src/app.ts');
      expect(calls[0].arguments.target_content).toBe('const a = 1;');
      expect(calls[0].arguments.replacement_content).toBe('const a = 2;');
    });

    it('normalizes parsed XML tool call arguments', () => {
      const text = `<tool_call name="edit_file">
  <filePath>src/app.ts</filePath>
  <target>const a = 1;</target>
  <replace>const a = 2;</replace>
</tool_call>`;
      const calls = ToolManager.parseToolCalls(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe('edit_file');
      expect(calls[0].arguments.file_path).toBe('src/app.ts');
      expect(calls[0].arguments.target_content).toBe('const a = 1;');
      expect(calls[0].arguments.replacement_content).toBe('const a = 2;');
    });

    it('normalizes arguments before executing tool', async () => {
      const ws = makeTempWorkspace();
      const testFile = path.join(ws, 'sample.ts');
      fs.writeFileSync(testFile, 'export const x = 1;', 'utf8');

      // Execute edit_file with non-standard argument names and camelCase names
      const result = await ToolManager.execute('edit_file', {
        filePath: 'sample.ts',
        target: 'export const x = 1;',
        replace: 'export const x = 2;'
      });

      expect(result).toContain('Success:');
      expect(fs.readFileSync(testFile, 'utf8')).toBe('export const x = 2;');
    });

    it('normalizes compound-key aliases like old_string / new_string (Claude style)', () => {
      const rawCalls = [
        {
          name: 'edit_file',
          arguments: {
            file_path: 'src/main.ts',
            old_string: 'const a = 1;',
            new_string: 'const a = 2;'
          }
        }
      ];
      const normalized = ToolManager.normalizeNativeToolCalls(rawCalls);
      expect(normalized[0].arguments.target_content).toBe('const a = 1;');
      expect(normalized[0].arguments.replacement_content).toBe('const a = 2;');
    });

    it('normalizes compound-key aliases like old_content / new_content (GPT style)', () => {
      const rawCalls = [
        {
          name: 'edit_file',
          arguments: {
            file_path: 'src/main.ts',
            old_content: 'const a = 1;',
            new_content: 'const a = 2;'
          }
        }
      ];
      const normalized = ToolManager.normalizeNativeToolCalls(rawCalls);
      expect(normalized[0].arguments.target_content).toBe('const a = 1;');
      expect(normalized[0].arguments.replacement_content).toBe('const a = 2;');
    });

    it('uses word-segment fallback for unusual compound keys', () => {
      const rawCalls = [
        {
          name: 'edit_file',
          arguments: {
            file_path: 'src/main.ts',
            existing_code: 'const a = 1;',  // "existing" is a target word
            updated_code: 'const a = 2;'    // "updated" is a replacement word
          }
        }
      ];
      const normalized = ToolManager.normalizeNativeToolCalls(rawCalls);
      expect(normalized[0].arguments.target_content).toBe('const a = 1;');
      expect(normalized[0].arguments.replacement_content).toBe('const a = 2;');
    });

    it('maps content to replacement_content for edit_file if replacement_content is missing', () => {
      const rawCalls = [
        {
          name: 'edit_file',
          arguments: {
            file_path: 'src/main.ts',
            target_content: 'const a = 1;',
            content: 'const a = 2;'
          }
        }
      ];
      const normalized = ToolManager.normalizeNativeToolCalls(rawCalls);
      expect(normalized[0].arguments.target_content).toBe('const a = 1;');
      expect(normalized[0].arguments.replacement_content).toBe('const a = 2;');
    });

    it('performs full-rewrite fallback for edit_file if target_content is missing', () => {
      const ws = makeTempWorkspace();
      const testFile = path.join(ws, 'main.ts');
      fs.writeFileSync(testFile, 'export const a = 1;', 'utf8');

      const rawCalls = [
        {
          name: 'edit_file',
          arguments: {
            file_path: 'main.ts',
            replacement_content: 'export const a = 2;'
          }
        }
      ];
      const normalized = ToolManager.normalizeNativeToolCalls(rawCalls);
      expect(normalized[0].arguments.target_content).toBe('export const a = 1;');
      expect(normalized[0].arguments.replacement_content).toBe('export const a = 2;');
    });

    it('executes edit_file as a full-file rewrite when target_content is missing', async () => {
      const ws = makeTempWorkspace();
      const testFile = path.join(ws, 'main.ts');
      fs.writeFileSync(testFile, 'export const a = 1;', 'utf8');

      const result = await ToolManager.execute('edit_file', {
        file_path: 'main.ts',
        replacement_content: 'export const a = 2;',
      });

      expect(result).toContain('Success: Edited file');
      expect(fs.readFileSync(testFile, 'utf8')).toBe('export const a = 2;');
    });

    it('executes edit_file as file creation when target_content is missing for a new file', async () => {
      const ws = makeTempWorkspace();
      const testFile = path.join(ws, 'new-file.ts');

      const result = await ToolManager.execute('edit_file', {
        file_path: 'new-file.ts',
        replacement_content: 'export const created = true;',
      });

      expect(result).toContain('Success: Wrote to file');
      expect(fs.readFileSync(testFile, 'utf8')).toBe('export const created = true;');
    });

    it('maps content to replacement_content for patch_file_lines if replacement_content is missing', () => {
      const rawCalls = [
        {
          name: 'patch_file_lines',
          arguments: {
            file_path: 'src/main.ts',
            start_line: '1',
            end_line: '2',
            content: 'const a = 2;'
          }
        }
      ];
      const normalized = ToolManager.normalizeNativeToolCalls(rawCalls);
      expect(normalized[0].arguments.replacement_content).toBe('const a = 2;');
    });

    it('normalizes find_references and find_definitions line and character arguments', () => {
      const rawCalls = [
        {
          name: 'find_references',
          arguments: {
            file_path: 'src/main.ts',
            line_number: '10',
            col: '5'
          }
        },
        {
          name: 'find_definitions',
          arguments: {
            file_path: 'src/main.ts',
            line_number: '20',
            column: '8'
          }
        }
      ];
      const normalized = ToolManager.normalizeNativeToolCalls(rawCalls);
      expect(normalized[0].arguments.line).toBe('10');
      expect(normalized[0].arguments.character).toBe('5');
      expect(normalized[1].arguments.line).toBe('20');
      expect(normalized[1].arguments.character).toBe('8');
    });

    it('blocks npm install and pip install of local paths', async () => {
      const result1 = await ToolManager.execute('run_command', {
        command: 'npm install ./components/molecules/Navigation'
      });
      expect(result1).toContain('Error: Cannot install a local path');

      const result2 = await ToolManager.execute('send_to_terminal', {
        command: 'pip install ../some_local_dir'
      });
      expect(result2).toContain('Error: Cannot install a local path');
    });
  });

  describe('MCP Tool Resolution and Argument Normalization', () => {
    let origGetAllTools: any;
    let origCallMcpTool: any;

    beforeEach(() => {
      origGetAllTools = MCPManager.getAllTools;
      origCallMcpTool = MCPManager.callMcpTool;
    });

    afterEach(() => {
      MCPManager.getAllTools = origGetAllTools;
      MCPManager.callMcpTool = origCallMcpTool;
    });

    it('maps prefix-less and slightly mismatched MCP tool names correctly', async () => {
      MCPManager.getAllTools = () => [
        {
          name: 'sequentialthinking',
          description: 'Thinking',
          serverName: 'SequentialThinking',
          inputSchema: { type: 'object', properties: { thought: { type: 'string' } } }
        }
      ];

      let calledServer = '';
      let calledTool = '';
      let calledArgs: any = null;
      MCPManager.callMcpTool = async (serverName, toolName, args) => {
        calledServer = serverName;
        calledTool = toolName;
        calledArgs = args;
        return 'success';
      };

      const res = await ToolManager.execute('sequential_thinking', { thought: 'Let\'s think' });
      expect(res).toBe('success');
      expect(calledServer).toBe('SequentialThinking');
      expect(calledTool).toBe('sequentialthinking');
      expect(calledArgs).toEqual({ thought: 'Let\'s think' });
    });

    it('normalizes argument names for MCP tools using expected schemas and general heuristics', () => {
      MCPManager.getAllTools = () => [
        {
          name: 'write_file',
          description: 'Write file',
          serverName: 'Filesystem',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' }
            }
          }
        }
      ];

      const rawCalls = [
        {
          name: 'mcp__Filesystem__write_file',
          arguments: {
            file_path: 'src/main.ts',
            text: 'const x = 1;'
          }
        }
      ];

      const normalized = ToolManager.normalizeNativeToolCalls(rawCalls);
      expect(normalized[0].arguments).toEqual({
        path: 'src/main.ts',
        content: 'const x = 1;'
      });
    });
  });
});
