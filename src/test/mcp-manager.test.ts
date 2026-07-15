import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MCPManager } from '../mcp-manager';
import { __setWorkspaceRoot } from './vscode-mock';

describe('MCPManager', () => {
  const tempDirs: string[] = [];

  function makeTempWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    tempDirs.push(dir);
    __setWorkspaceRoot(dir);
    return dir;
  }

  afterEach(async () => {
    await MCPManager.stopAllServers();
    await new Promise(resolve => setTimeout(resolve, 200));
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        // Ignore EBUSY/lock issues on Windows temp dirs
      }
    }
  });

  it('populates default configurations including memory, puppeteer, filesystem, and sequential-thinking', () => {
    const mockGlobalState = new Map<string, any>();
    const mockContext = {
      globalState: {
        get: (key: string, defaultValue: any) => mockGlobalState.has(key) ? mockGlobalState.get(key) : defaultValue,
        update: (key: string, value: any) => {
          mockGlobalState.set(key, value);
          return Promise.resolve();
        }
      }
    } as any;

    MCPManager.initialize(mockContext);
    const status = MCPManager.getServersStatus();

    expect(status).toHaveLength(6);
    const names = status.map(s => s.name);
    expect(names).toContain('Memory');
    expect(names).toContain('Puppeteer');
    expect(names).toContain('Filesystem');
    expect(names).toContain('SequentialThinking');
    expect(names).toContain('Git');
    expect(names).toContain('Context7');
  });

  it('successfully completes handshake and lists tools from a running server', async () => {
    const workspace = makeTempWorkspace();
    
    // Write a mock JSON-RPC MCP server script to run locally
    const mockServerScript = `
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });

      rl.on('line', (line) => {
        try {
          const req = JSON.parse(line);
          if (req.method === 'initialize') {
            console.log(JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                serverInfo: { name: 'mock-server', version: '1.0.0' }
              }
            }));
          } else if (req.method === 'tools/list') {
            console.log(JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: {
                tools: [
                  {
                    name: 'test_tool',
                    description: 'A test tool',
                    inputSchema: { type: 'object', properties: {} }
                  }
                ]
              }
            }));
          } else if (req.method === 'tools/call') {
            console.log(JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: {
                content: [{ type: 'text', text: 'Hello from test_tool' }]
              }
            }));
          }
        } catch (e) {
          // ignore
        }
      });
    `;
    const scriptPath = path.join(workspace, 'mock-server.js');
    fs.writeFileSync(scriptPath, mockServerScript, 'utf8');

    const mockGlobalState = new Map<string, any>();
    const mockContext = {
      globalState: {
        get: (key: string) => mockGlobalState.get(key),
        update: (key: string, value: any) => {
          mockGlobalState.set(key, value);
          return Promise.resolve();
        }
      }
    } as any;

    MCPManager.initialize(mockContext);

    // Add our mock server specifically
    await MCPManager.addServer({
      name: 'MockServer',
      command: 'node',
      args: [scriptPath]
    });

    const status = MCPManager.getServersStatus().find(s => s.name === 'MockServer');
    expect(status?.status).toBe('Connected');

    const tools = MCPManager.getAllTools();
    expect(tools.some(t => t.name === 'test_tool' && t.serverName === 'MockServer')).toBe(true);

    const callResult = await MCPManager.callMcpTool('MockServer', 'test_tool', {});
    expect(callResult).toBe('Hello from test_tool');
  });

  it('saves and restores tool definitions in globalState', async () => {
    const mockGlobalState = new Map<string, any>();
    const mockContext = {
      globalState: {
        get: (key: string, defaultValue: any) => mockGlobalState.has(key) ? mockGlobalState.get(key) : defaultValue,
        update: (key: string, value: any) => {
          mockGlobalState.set(key, value);
          return Promise.resolve();
        }
      }
    } as any;

    MCPManager.initialize(mockContext);
    
    // Simulate tools already cached in globalState
    mockGlobalState.set('k-horizon-mcp-tools', {
      'CachedServer': [
        {
          name: 'cached_tool',
          description: 'A cached tool',
          inputSchema: { type: 'object', properties: {} }
        }
      ]
    });

    // Re-initialize to trigger tool loading from cache
    MCPManager.initialize(mockContext);

    const tools = MCPManager.getAllTools();
    const found = tools.find(t => t.name === 'cached_tool' && t.serverName === 'CachedServer');
    expect(found).toBeDefined();
    expect(found?.description).toBe('A cached tool');
  });

  it('immediately rejects pending request resolvers if the server process exits', async () => {
    const workspace = makeTempWorkspace();
    
    // Create a mock server script that runs but doesn't respond to tools/call, then we kill it
    const mockServerScript = `
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });

      rl.on('line', (line) => {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1' } }
          }));
        } else if (req.method === 'tools/list') {
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { tools: [{ name: 'slow_tool', description: 'slow', inputSchema: { type: 'object', properties: {} } }] }
          }));
        }
        // ignore tools/call to let it hang/wait
      });
    `;
    const scriptPath = path.join(workspace, 'slow-server.js');
    fs.writeFileSync(scriptPath, mockServerScript, 'utf8');

    const mockGlobalState = new Map<string, any>();
    const mockContext = {
      globalState: {
        get: (key: string, defaultValue: any) => mockGlobalState.has(key) ? mockGlobalState.get(key) : defaultValue,
        update: (key: string, value: any) => {
          mockGlobalState.set(key, value);
          return Promise.resolve();
        }
      }
    } as any;

    MCPManager.initialize(mockContext);
    await MCPManager.addServer({
      name: 'SlowServer',
      command: 'node',
      args: [scriptPath]
    });

    // Make a request to slow_tool, which won't respond. It should return a promise.
    const callPromise = MCPManager.callMcpTool('SlowServer', 'slow_tool', {});

    // Now stop the server immediately to simulate process exit while request is pending.
    await MCPManager.stopAllServers();

    // Verify it rejects immediately instead of timing out after 15 seconds.
    const startTime = Date.now();
    const result = await callPromise;
    const duration = Date.now() - startTime;

    expect(result).toContain('[MCP TOOL ERROR] Execution failed:');
    expect(duration).toBeLessThan(2000); // Should be almost instant, way less than 15s timeout
  });

  it('automatically attempts to reconnect when calling a tool on a disconnected server', async () => {
    const workspace = makeTempWorkspace();
    const mockServerScript = `
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });

      rl.on('line', (line) => {
        const req = JSON.parse(line);
        if (req.method === 'initialize') {
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock', version: '1' } }
          }));
        } else if (req.method === 'tools/list') {
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { tools: [{ name: 'test_tool', description: 'test', inputSchema: { type: 'object', properties: {} } }] }
          }));
        } else if (req.method === 'tools/call') {
          console.log(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { content: [{ type: 'text', text: 'Success' }] }
          }));
        }
      });
    `;
    const scriptPath = path.join(workspace, 'reconnect-server.js');
    fs.writeFileSync(scriptPath, mockServerScript, 'utf8');

    const mockGlobalState = new Map<string, any>();
    const mockContext = {
      globalState: {
        get: (key: string, defaultValue: any) => mockGlobalState.has(key) ? mockGlobalState.get(key) : defaultValue,
        update: (key: string, value: any) => {
          mockGlobalState.set(key, value);
          return Promise.resolve();
        }
      }
    } as any;

    MCPManager.initialize(mockContext);
    await MCPManager.addServer({
      name: 'ReconnectServer',
      command: 'node',
      args: [scriptPath]
    });

    // Verify it is connected initially
    let status = MCPManager.getServersStatus().find(s => s.name === 'ReconnectServer');
    expect(status?.status).toBe('Connected');

    // Explicitly stop the server to put it in Disconnected state
    await MCPManager.stopAllServers();
    status = MCPManager.getServersStatus().find(s => s.name === 'ReconnectServer');
    expect(status?.status).toBe('Disconnected');

    // Call callMcpTool, which should trigger ensureServerConnected and connect automatically
    const result = await MCPManager.callMcpTool('ReconnectServer', 'test_tool', {});
    expect(result).toBe('Success');

    status = MCPManager.getServersStatus().find(s => s.name === 'ReconnectServer');
    expect(status?.status).toBe('Connected');
  });

  it('fails starting the server and sets error status if the command does not exist on system PATH', async () => {
    const mockGlobalState = new Map<string, any>();
    const mockContext = {
      globalState: {
        get: (key: string, defaultValue: any) => mockGlobalState.has(key) ? mockGlobalState.get(key) : defaultValue,
        update: (key: string, value: any) => {
          mockGlobalState.set(key, value);
          return Promise.resolve();
        }
      }
    } as any;

    MCPManager.initialize(mockContext);

    // Mock commandExists to return false for our fake command
    const origCommandExists = (MCPManager as any).commandExists;
    (MCPManager as any).commandExists = (cmd: string) => cmd === 'fake-nonexistent-cmd' ? false : origCommandExists(cmd);

    try {
      await expect(MCPManager.addServer({
        name: 'FailServer',
        command: 'fake-nonexistent-cmd',
        args: []
      })).rejects.toThrow('was not found on your system PATH');

      const status = MCPManager.getServersStatus().find(s => s.name === 'FailServer');
      expect(status?.status).toBe('Error');
      expect(status?.error).toContain('was not found on your system PATH');
    } finally {
      (MCPManager as any).commandExists = origCommandExists;
    }
  });
});
