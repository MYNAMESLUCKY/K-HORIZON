import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { AIService } from './ai-service';
import { getWorkspaceRoot } from './workspace-utils';

export interface McpServerConfig {
  name: string;
  /** For remote HTTP/SSE MCP servers (e.g. Context7). When set, command/args are ignored. */
  url?: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export class MCPManager {
  private static activeProcesses = new Map<string, ChildProcess>();
  private static serverTools = new Map<string, McpTool[]>();
  private static serverStatus = new Map<string, 'Connected' | 'Disconnected' | 'Error' | 'Connecting'>();
  private static errorMessages = new Map<string, string>();
  private static responseResolvers = new Map<string, (res: any) => void>();
  private static requestIdCounter = 1;
  private static context: vscode.ExtensionContext;
  private static connectionPromises = new Map<string, Promise<void>>();
  private static lastConnectTime = new Map<string, number>();

  private static getCachedTools(): Record<string, McpTool[]> {
    return this.context.globalState.get<Record<string, McpTool[]>>('k-horizon-mcp-tools') || {};
  }

  private static setCachedTools(tools: Record<string, McpTool[]>) {
    this.context.globalState.update('k-horizon-mcp-tools', tools);
  }

  public static initialize(context: vscode.ExtensionContext) {
    this.context = context;
    // Load tools from cache
    const cached = this.getCachedTools();
    for (const [serverName, tools] of Object.entries(cached)) {
      this.serverTools.set(serverName, tools);
    }
    this.startAllServers();
  }

  private static getStoredConfigs(): McpServerConfig[] {
    let configs = this.context.globalState.get<McpServerConfig[]>('k-horizon-mcp-servers', []) || [];

    // Check if we need to migrate/update the defaults (i.e. if they contain the old non-existent 'Git' default server or have fewer than expected servers)
    const hasOldDefaults = configs.some(c => c.name === 'Git');

    if (!configs || configs.length < 7 || hasOldDefaults) {
      configs = [
        {
          name: 'Memory',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-memory']
        },
        {
          name: 'Puppeteer',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-puppeteer']
        },
        {
          name: 'Filesystem',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '${workspaceRoot}']
        },
        {
          name: 'SequentialThinking',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-sequential-thinking']
        },
        {
          name: 'GroundedDocs',
          command: 'npx',
          args: ['-y', '@arabold/docs-mcp-server']
        },
        {
          // Context7: free, public, no-auth remote HTTP MCP for up-to-date library docs
          name: 'Context7',
          url: 'https://mcp.context7.com/mcp',
          command: '',
          args: []
        },
        {
          // ProContext: open-source documentation layer for AI coding agents (2000+ libraries)
          // 4 MCP tools: resolve, search, read, outline — MIT licensed, stdio transport via uvx
          name: 'ProContext',
          command: 'uvx',
          args: ['procontext']
        }
      ];
      this.context.globalState.update('k-horizon-mcp-servers', configs);
    }
    return configs;
  }

  private static setStoredConfigs(configs: McpServerConfig[]) {
    this.context.globalState.update('k-horizon-mcp-servers', configs);
  }

  public static async startAllServers() {
    const configs = this.getStoredConfigs();
    await Promise.allSettled(
      configs.map(async (config) => {
        try {
          await this.startServer(config);
        } catch (err: any) {
          console.error(`Failed to start MCP server ${config.name}:`, err);
        }
      })
    );
  }

  public static async stopAllServers() {
    for (const [name] of this.activeProcesses) {
      this.stopServer(name);
    }
  }

  public static async addServer(config: McpServerConfig): Promise<void> {
    const configs = this.getStoredConfigs();
    if (configs.some(c => c.name === config.name)) {
      throw new Error(`MCP Server with name "${config.name}" already exists.`);
    }
    configs.push(config);
    this.setStoredConfigs(configs);
    await this.startServer(config);
  }

  public static async deleteServer(name: string): Promise<void> {
    this.stopServer(name);
    this.serverTools.delete(name);
    const cached = this.getCachedTools();
    delete cached[name];
    this.setCachedTools(cached);

    const configs = this.getStoredConfigs();
    const filtered = configs.filter(c => c.name !== name);
    this.setStoredConfigs(filtered);
  }

  public static async restartServer(name: string): Promise<void> {
    const configs = this.getStoredConfigs();
    const config = configs.find(c => c.name === name);
    if (!config) {
      throw new Error(`MCP Server with name "${name}" is not configured.`);
    }
    this.lastConnectTime.delete(name);
    this.stopServer(name);
    await this.startServer(config);
  }

  public static getServersStatus() {
    const configs = this.getStoredConfigs();
    return configs.map(c => ({
      name: c.name,
      command: c.command,
      args: c.args,
      status: this.serverStatus.get(c.name) || 'Disconnected',
      error: this.errorMessages.get(c.name) || ''
    }));
  }

  public static getAllTools(): (McpTool & { serverName: string })[] {
    const list: (McpTool & { serverName: string })[] = [];
    for (const [serverName, tools] of this.serverTools.entries()) {
      for (const tool of tools) {
        list.push({ ...tool, serverName });
      }
    }
    return list;
  }

  private static stopServer(name: string) {
    const proc = this.activeProcesses.get(name);
    if (proc) {
      try {
        proc.kill();
      } catch (e) {
        // Ignore kill errors
      }
      this.activeProcesses.delete(name);
    }
    this.serverStatus.set(name, 'Disconnected');
    this.errorMessages.delete(name);
  }

  private static async startServer(config: McpServerConfig): Promise<void> {
    let promise = this.connectionPromises.get(config.name);
    if (promise) {
      return promise;
    }

    promise = (async () => {
      if (config.url) {
        await this.startHttpServer(config);
        return;
      }

      this.stopServer(config.name);
      this.serverStatus.set(config.name, 'Connecting');
      this.lastConnectTime.set(config.name, Date.now());

      const env = { ...process.env, ...(config.env || {}) };
      if (config.name === 'Puppeteer') {
        const browserPath = this.findSystemBrowser();
        if (browserPath) {
          env['PUPPETEER_EXECUTABLE_PATH'] = browserPath;
          env['PUPPETEER_SKIP_CHROMIUM_DOWNLOAD'] = 'true';
        }
      }
      const workspaceRoot = getWorkspaceRoot();
      let command = config.command;
      let args = [...config.args];

      if (workspaceRoot) {
        args = args.map(arg => {
          const resolved = arg.replace(/\${workspaceRoot}/g, workspaceRoot);
          if (resolved.startsWith('./') || resolved.startsWith('.\\')) {
            return path.join(workspaceRoot, resolved);
          }
          return resolved;
        });
      } else {
        args = args.filter(arg => !arg.includes('${workspaceRoot}'));
      }

      return new Promise<void>((resolve, reject) => {
        let proc: ChildProcess;
        try {
          proc = spawn(command, args, {
            env,
            cwd: workspaceRoot || undefined,
            shell: process.platform === 'win32'
          });
        } catch (err: any) {
          this.serverStatus.set(config.name, 'Error');
          this.errorMessages.set(config.name, err.message);
          reject(err);
          return;
        }

        this.activeProcesses.set(config.name, proc);

        let stdoutBuffer = '';
        let stderrBuffer = '';

        proc.stdout?.on('data', (data) => {
          stdoutBuffer += data.toString();
          let lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              const jsonStart = trimmed.indexOf('{');
              if (jsonStart !== -1) {
                this.handleMcpMessage(config.name, trimmed.substring(jsonStart));
              } else {
                console.log(`[MCP ${config.name} STDOUT LOG]`, trimmed);
              }
            }
          }
        });

        proc.stderr?.on('data', (data) => {
          stderrBuffer += data.toString();
          console.error(`[MCP ${config.name} STDERR]`, data.toString());
        });

        proc.on('close', (code) => {
          if (this.activeProcesses.get(config.name) !== proc) {
            return;
          }
          this.activeProcesses.delete(config.name);
          const errMessage = `Process exited with code ${code}. Error: ${stderrBuffer.trim()}`;
          if (this.serverStatus.get(config.name) !== 'Disconnected') {
            this.serverStatus.set(config.name, 'Error');
            this.errorMessages.set(config.name, errMessage);
          }
          // Reject pending requests
          for (const [key, resolver] of this.responseResolvers.entries()) {
            if (key.startsWith(`${config.name}::`)) {
              resolver({ error: { message: errMessage } });
              this.responseResolvers.delete(key);
            }
          }
        });

        proc.on('error', (err) => {
          if (this.activeProcesses.get(config.name) !== proc) {
            return;
          }
          this.serverStatus.set(config.name, 'Error');
          this.errorMessages.set(config.name, err.message);
          // Reject pending requests
          for (const [key, resolver] of this.responseResolvers.entries()) {
            if (key.startsWith(`${config.name}::`)) {
              resolver({ error: { message: err.message } });
              this.responseResolvers.delete(key);
            }
          }
        });

        this.initializeProtocol(config.name)
          .then(() => resolve())
          .catch(err => {
            this.stopServer(config.name);
            this.serverStatus.set(config.name, 'Error');
            this.errorMessages.set(config.name, `Initialization failed: ${err.message}`);
            reject(err);
          });
      });
    })();

    this.connectionPromises.set(config.name, promise);
    try {
      await promise;
    } finally {
      this.connectionPromises.delete(config.name);
    }
  }

  /**
   * Connects to a remote HTTP MCP server using the Streamable HTTP transport.
   * Properly manages the mcp-session-id session token required by servers like Context7.
   */
  private static async startHttpServer(config: McpServerConfig): Promise<void> {
    const url = config.url!;
    this.serverStatus.set(config.name, 'Connecting');
    this.errorMessages.delete(config.name);
    this.lastConnectTime.set(config.name, Date.now());

    let httpRequestId = 1;
    let sessionId: string | null = null;

    const sendHttpRequest = async (method: string, params: any): Promise<any> => {
      const id = httpRequestId++;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      };
      if (sessionId) {
        headers['mcp-session-id'] = sessionId;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
      });

      // Capture session ID from any response
      const newSession = response.headers.get('mcp-session-id');
      if (newSession) sessionId = newSession;

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream')) {
        // Buffer the full SSE response and find the matching message id
        const text = await response.text();
        for (const line of text.split('\n')) {
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data && data !== '[DONE]') {
              try {
                const msg = JSON.parse(data);
                if (msg.id === id) {
                  if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
                  return msg.result;
                }
              } catch (e) { /* ignore non-JSON lines */ }
            }
          }
        }
        throw new Error('No matching response in SSE stream');
      } else {
        const json = await response.json() as any;
        if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
        return json.result;
      }
    };

    try {
      // 1. Initialize handshake (this sets the session ID)
      const initResult = await sendHttpRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'k-horizon-client', version: '1.0.0' }
      });
      console.log(`[MCP ${config.name}] Connected. Server:`, initResult?.serverInfo, `Session: ${sessionId}`);

      // 2. Send initialized notification (fire-and-forget, with session)
      const notifHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (sessionId) notifHeaders['mcp-session-id'] = sessionId;
      fetch(url, {
        method: 'POST',
        headers: notifHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
      }).catch(() => { });

      // 3. List tools
      const toolsResult = await sendHttpRequest('tools/list', {});
      const tools = (toolsResult?.tools || []) as McpTool[];

      this.serverTools.set(config.name, tools);
      this.serverStatus.set(config.name, 'Connected');

      // Update cache
      const cached = this.getCachedTools();
      cached[config.name] = tools;
      this.setCachedTools(cached);

      // Patch callMcpTool for this server to use HTTP
      // Store sender function keyed by server name so callMcpTool can use it
      (this as any)[`http_sender_${config.name}`] = sendHttpRequest;
    } catch (err: any) {
      this.serverStatus.set(config.name, 'Error');
      this.errorMessages.set(config.name, `HTTP MCP failed: ${err.message}`);
      throw err;
    }
  }

  private static handleMcpMessage(serverName: string, messageText: string) {
    try {
      const message = JSON.parse(messageText);
      if (message.id !== undefined) {
        const resolverKey = `${serverName}::${message.id}`;
        const resolver = this.responseResolvers.get(resolverKey);
        if (resolver) {
          resolver(message);
          this.responseResolvers.delete(resolverKey);
        }
      }
    } catch (err) {
      console.error(`Failed to parse MCP message from ${serverName}:`, messageText, err);
    }
  }

  private static sendRequest(serverName: string, method: string, params: any): Promise<any> {
    const proc = this.activeProcesses.get(serverName);
    if (!proc || !proc.stdin) {
      return Promise.reject(new Error(`Server "${serverName}" is not running.`));
    }

    const id = this.requestIdCounter++;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const resolverKey = `${serverName}::${id}`;

      const timeout = setTimeout(() => {
        this.responseResolvers.delete(resolverKey);
        reject(new Error(`Request "${method}" to server "${serverName}" timed out after 15 seconds.`));
      }, 15000);

      this.responseResolvers.set(resolverKey, (response: any) => {
        clearTimeout(timeout);
        if (response.error) {
          reject(new Error(response.error.message || `JSON-RPC Error: ${JSON.stringify(response.error)}`));
        } else {
          resolve(response.result);
        }
      });

      proc.stdin?.write(JSON.stringify(request) + '\n');
    });
  }

  private static sendNotification(serverName: string, method: string, params: any): void {
    const proc = this.activeProcesses.get(serverName);
    if (!proc || !proc.stdin) return;

    const notification = {
      jsonrpc: '2.0',
      method,
      params
    };
    proc.stdin.write(JSON.stringify(notification) + '\n');
  }

  private static async initializeProtocol(serverName: string): Promise<void> {
    // 1. Send 'initialize' (response is informational — capabilities exchange)
    await this.sendRequest(serverName, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'k-horizon-client',
        version: '1.0.0'
      }
    });

    // 2. Send 'notifications/initialized'
    this.sendNotification(serverName, 'notifications/initialized', {});

    // 3. Request tools list
    await this.fetchServerTools(serverName);
    this.serverStatus.set(serverName, 'Connected');
  }

  public static async fetchServerTools(serverName: string): Promise<void> {
    try {
      const toolsResult = await this.sendRequest(serverName, 'tools/list', {});
      const tools = (toolsResult.tools || []) as McpTool[];
      this.serverTools.set(serverName, tools);

      const cached = this.getCachedTools();
      cached[serverName] = tools;
      this.setCachedTools(cached);
    } catch (err: any) {
      console.error(`Failed to list tools for MCP server ${serverName}:`, err);
      throw err;
    }
  }

  private static async ensureServerConnected(name: string, forceReconnect = false): Promise<void> {
    const status = this.serverStatus.get(name);
    if (status === 'Connected' && !forceReconnect) {
      return;
    }

    const lastAttempt = this.lastConnectTime.get(name) || 0;
    const cooldown = 5000;
    if (status === 'Error' && Date.now() - lastAttempt < cooldown && !forceReconnect) {
      const errMsg = this.errorMessages.get(name) || 'Server is in error state.';
      throw new Error(`MCP Server "${name}" is offline due to a recent error: ${errMsg}. Please wait a few seconds before retrying.`);
    }

    if (forceReconnect) {
      this.stopServer(name);
    }

    const configs = this.getStoredConfigs();
    const config = configs.find(c => c.name === name);
    if (!config) {
      throw new Error(`MCP Server with name "${name}" is not configured.`);
    }
    await this.startServer(config);
  }

  public static async callMcpTool(serverName: string, toolName: string, args: any): Promise<string> {
    let attempts = 0;
    const maxAttempts = 2;
    while (attempts < maxAttempts) {
      try {
        attempts++;
        await this.ensureServerConnected(serverName, attempts > 1);

        // Route HTTP-based servers through their stored sender function
        const httpSender = (this as any)[`http_sender_${serverName}`];
        let result: any;
        if (httpSender) {
          result = await httpSender('tools/call', { name: toolName, arguments: args });
        } else {
          result = await this.sendRequest(serverName, 'tools/call', {
            name: toolName,
            arguments: args
          });
        }

        if (!result || !result.content || !Array.isArray(result.content)) {
          return JSON.stringify(result);
        }

        const contentParts = await Promise.all(
          result.content.map(async (c: any) => {
            if (c.type === 'text') return c.text;
            if (c.type === 'image') {
              try {
                const desc = await AIService.analyzeImage(
                  c.data,
                  c.mimeType || 'image/png',
                  'Describe what is visible in this screenshot in detail, including layout, text, buttons, inputs, and structure.'
                );
                return `[Image Content Vision Analysis]:\n${desc}`;
              } catch (err: any) {
                return `[Image Content: ${c.mimeType || 'unknown format'} (Vision analysis failed: ${err.message})]`;
              }
            }
            return JSON.stringify(c);
          })
        );

        return contentParts.join('\n');
      } catch (err: any) {
        const prevStatus = this.serverStatus.get(serverName);

        this.stopServer(serverName);
        this.serverStatus.set(serverName, 'Error');
        this.errorMessages.set(serverName, err.message);
        delete (this as any)[`http_sender_${serverName}`];

        const isRetryable = err.message && (
          err.message.includes('timeout') ||
          err.message.includes('closed') ||
          err.message.includes('connection') ||
          err.message.includes('exit') ||
          err.message.includes('offline') ||
          err.message.includes('not running')
        );

        if (attempts < maxAttempts && isRetryable && prevStatus !== 'Disconnected') {
          console.warn(`MCP Tool execution failed, retrying (${attempts}/${maxAttempts})... Error: ${err.message}`);
          continue;
        }

        return `[MCP TOOL ERROR] Execution failed: ${err.message}`;
      }
    }
    return `[MCP TOOL ERROR] Execution failed after ${maxAttempts} attempts.`;
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
}
