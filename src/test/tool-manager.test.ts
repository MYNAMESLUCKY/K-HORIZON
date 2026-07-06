import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolManager } from '../tool-manager';
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
});
