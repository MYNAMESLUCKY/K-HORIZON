import * as path from 'path';

let workspaceRoot = process.cwd();

export function __setWorkspaceRoot(root: string) {
  workspaceRoot = root;
  workspace.workspaceFolders = [{ uri: Uri.file(root) }];
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export class Position {
  constructor(public line: number, public character: number) {}
}

export class Range {
  constructor(public start: Position, public end: Position) {}
}

export class Location {
  constructor(public uri: Uri, public range: Range) {}
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum ViewColumn {
  One = 1,
  Two = 2,
}

export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
}

export class Uri {
  constructor(public fsPath: string, public scheme = 'file') {}

  static file(fsPath: string) {
    return new Uri(path.resolve(fsPath));
  }
}

export class CancellationTokenSource {
  token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => {} }),
  };

  cancel() {
    this.token.isCancellationRequested = true;
  }

  dispose() {}
}

export const workspace = {
  workspaceFolders: [{ uri: Uri.file(workspaceRoot) }],
  getConfiguration: () => ({
    get: (_key: string) => undefined,
  }),
  asRelativePath: (target: string | Uri) => {
    const fsPath = typeof target === 'string' ? target : target.fsPath;
    return path.relative(workspaceRoot, fsPath) || path.basename(fsPath);
  },
  openTextDocument: async (uri: Uri) => ({
    uri,
    getText: () => '',
  }),
  findFiles: async () => [],
};

export const window = {
  activeTextEditor: undefined as any,
  terminals: [] as any[],
  showInformationMessage: () => undefined,
  showErrorMessage: () => undefined,
  createTerminal: (name: string) => {
    const terminal = {
      name,
      show: () => undefined,
      sendText: () => undefined,
    };
    window.terminals.push(terminal);
    return terminal;
  },
  createWebviewPanel: () => ({
    webview: { html: '' },
  }),
  showTextDocument: async () => undefined,
  onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
};

export const env = {
  shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
};

export const languages = {
  getDiagnostics: () => [],
};

export const commands = {
  executeCommand: async () => [],
};

export const extensions = {
  all: [],
};

export const lm = {
  selectChatModels: async () => [],
};
