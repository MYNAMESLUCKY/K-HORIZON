import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type AgentTraceEvent = {
  runId: string;
  sessionId?: string;
  type: string;
  timestamp: number;
  data?: Record<string, unknown>;
};

export class AgentTrace {
  public static createRunId(): string {
    return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  public static append(event: AgentTraceEvent): void {
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) return;

      const traceDir = path.join(workspaceRoot, '.k-horizon', 'runs');
      fs.mkdirSync(traceDir, { recursive: true });

      const tracePath = path.join(traceDir, `${event.runId}.jsonl`);
      fs.appendFileSync(tracePath, JSON.stringify(event) + '\n', 'utf8');
    } catch (err) {
      console.error('K-Horizon trace write failed:', err);
    }
  }
}
