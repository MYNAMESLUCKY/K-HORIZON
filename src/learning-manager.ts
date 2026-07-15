import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AIService } from './ai-service';
import { ChatMessage } from './types';
import { DiffHandler } from './diff-handler';

export interface AgentLearning {
  id: string;
  timestamp: number;
  source: 'user_correction' | 'self_correction';
  mistake: string;
  correction: string;
  modelId?: string;
}

export class AgentLearningManager {
  private static getFilePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.k-horizon', 'agent-learning.json');
  }

  public static async loadLearnings(workspaceRoot: string): Promise<AgentLearning[]> {
    if (!workspaceRoot) return [];
    const filePath = this.getFilePath(workspaceRoot);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content) as AgentLearning[];
      }
    } catch (err) {
      console.error('[AgentLearningManager] Failed to load learnings:', err);
    }
    return [];
  }

  public static async saveLearning(workspaceRoot: string, learning: Omit<AgentLearning, 'id' | 'timestamp'>): Promise<AgentLearning> {
    if (!workspaceRoot) {
      throw new Error('Workspace root is required to save agent learning.');
    }
    const filePath = this.getFilePath(workspaceRoot);
    const learnings = await this.loadLearnings(workspaceRoot);
    
    const newLearning: AgentLearning = {
      id: 'learn_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now(),
      timestamp: Date.now(),
      ...learning
    };

    learnings.push(newLearning);

    try {
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(learnings, null, 2), 'utf8');
    } catch (err) {
      console.error('[AgentLearningManager] Failed to save learning:', err);
      throw err;
    }

    return newLearning;
  }

  public static async deleteLearning(workspaceRoot: string, id: string): Promise<void> {
    if (!workspaceRoot) return;
    const filePath = this.getFilePath(workspaceRoot);
    let learnings = await this.loadLearnings(workspaceRoot);
    learnings = learnings.filter(l => l.id !== id);
    try {
      fs.writeFileSync(filePath, JSON.stringify(learnings, null, 2), 'utf8');
    } catch (err) {
      console.error('[AgentLearningManager] Failed to delete learning:', err);
    }
  }

  public static async loadLearningsAsPrompt(workspaceRoot: string): Promise<string> {
    const learnings = await this.loadLearnings(workspaceRoot);
    if (learnings.length === 0) return '';

    let prompt = `## Agent Continuous Learning & Self-Improvement (Mistakes to Avoid)
You have accumulated the following rules/learnings from your previous runs and user feedback. You MUST strictly adhere to these instructions to avoid repeating past mistakes:`;

    learnings.forEach((learning, index) => {
      const sourceStr = learning.source === 'user_correction' ? 'User Feedback' : 'Self-Correction';
      prompt += `\n\nRule #${index + 1} [Source: ${sourceStr}]:
- Mistake / Trigger: ${learning.mistake}
- Required Behavior: ${learning.correction}`;
    });

    return prompt;
  }

  public static async findMatchingLearnings(workspaceRoot: string, query: string): Promise<AgentLearning[]> {
    if (!workspaceRoot) return [];
    try {
      const learnings = await this.loadLearnings(workspaceRoot);
      const q = (query || '').toLowerCase().trim();
      if (!q) return learnings;
      return learnings.filter(l => (l.mistake + ' ' + l.correction).toLowerCase().includes(q));
    } catch (e) {
      return [];
    }
  }

  /**
   * Run self-improvement reflection.
   * Analyzes the chat history to see what went wrong (e.g. compile/test failure)
   * and how it was successfully resolved, or if the user corrected the agent.
   * Then stores it as a learning rule in the background.
   */
  public static async reflectAndLearn(
    workspaceRoot: string,
    chatHistory: ChatMessage[],
    compileHealAttempts: number,
    testHealAttempts: number,
    modelId?: string
  ): Promise<AgentLearning | null> {
    if (!workspaceRoot) return null;

    try {
      // Gather the last 15 messages for context
      const contextHistory = chatHistory.slice(-15);
      if (contextHistory.length === 0) return null;

      const historyStr = contextHistory.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n\n');
      
      const reflectionInstruction = `You are a meta-cognition module for an AI agent.
Analyze the following conversation history from a development session.
Determine if:
1. The agent made mistakes (compile errors, test failures, or incorrect code/logic) and successfully resolved them (via self-healing or rewriting).
2. The user explicitly corrected the agent, pointed out mistakes, or told the agent what it did wrong/what it needs to work on.

If a mistake and its corresponding correction/required behavior are identified, formulate a single, concise, model-agnostic learning rule to prevent repeating this mistake.

Output format MUST be a valid JSON object matching this schema exactly:
{
  "hasLearning": true,
  "mistake": "Short description of the mistake/issue (e.g., used incorrect parameter name in API call)",
  "correction": "Actionable rule for what to do instead (e.g., verify parameter names against the schema in routes.ts)"
}
If no mistakes/corrections were identified, set "hasLearning" to false. Do not include any extra text or explanation outside the JSON block.`;

      const settings = AIService.getSettings();
      const reflectionModel = modelId || settings.chatModel;
      
      const response = await AIService.streamResponse(
        [{ role: 'user', content: `Session History:\n${historyStr}\n\nAnalyze and formulate the learning rule if applicable.`, timestamp: Date.now() }],
        reflectionInstruction,
        () => {},
        reflectionModel || undefined,
        settings.provider || undefined,
        0.1
      );

      // Parse JSON from response
      const jsonStart = response.indexOf('{');
      const jsonEnd = response.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const jsonStr = response.substring(jsonStart, jsonEnd + 1);
        const parsed = JSON.parse(jsonStr);
        if (parsed.hasLearning && parsed.mistake && parsed.correction) {
          // Avoid duplicate learnings
          const learnings = await this.loadLearnings(workspaceRoot);
          const isDuplicate = learnings.some(l => 
            l.mistake.toLowerCase() === parsed.mistake.trim().toLowerCase() ||
            l.correction.toLowerCase() === parsed.correction.trim().toLowerCase()
          );
          if (!isDuplicate) {
            const learning = await this.saveLearning(workspaceRoot, {
              source: compileHealAttempts > 0 || testHealAttempts > 0 ? 'self_correction' : 'user_correction',
              mistake: parsed.mistake.trim(),
              correction: parsed.correction.trim(),
              modelId: reflectionModel
            });
            return learning;
          }
        }
      }
    } catch (err) {
      console.error('[AgentLearningManager] Self-reflection learning failed:', err);
    }
    return null;
  }
}

export interface ErrorFixRecord {
  id: string;
  timestamp: number;
  error: string;
  category: 'compile' | 'test-failure';
  files: string[];
  diff: string;
}

export class ErrorFixMemoryManager {
  private static getFilePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.k-horizon', 'error-fix-memory.json');
  }

  public static async loadMemory(workspaceRoot: string): Promise<ErrorFixRecord[]> {
    if (!workspaceRoot) return [];
    const filePath = this.getFilePath(workspaceRoot);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content) as ErrorFixRecord[];
      }
    } catch (err) {
      console.error('[ErrorFixMemoryManager] Failed to load memory:', err);
    }
    return [];
  }

  public static async saveFix(
    workspaceRoot: string,
    error: string,
    category: 'compile' | 'test-failure',
    files: string[],
    diff: string
  ): Promise<void> {
    if (!workspaceRoot || !error.trim() || !diff.trim()) return;

    const filePath = this.getFilePath(workspaceRoot);
    try {
      const memory = await this.loadMemory(workspaceRoot);
      const isDuplicate = memory.some(rec => rec.error === error && rec.diff === diff);
      if (isDuplicate) return;

      const newRecord: ErrorFixRecord = {
        id: 'fix_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now(),
        timestamp: Date.now(),
        error,
        category,
        files,
        diff
      };

      memory.push(newRecord);
      if (memory.length > 100) {
        memory.shift();
      }

      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), 'utf8');
    } catch (err) {
      console.error('[ErrorFixMemoryManager] Failed to save fix:', err);
    }
  }

  public static async findMatchingFixesAsPrompt(workspaceRoot: string, errorText: string): Promise<string> {
    if (!workspaceRoot || !errorText) return '';
    try {
      const memory = await this.loadMemory(workspaceRoot);
      if (memory.length === 0) return '';

      const matches = this.findMatchingFixes(errorText, memory);
      if (matches.length === 0) return '';

      let prompt = '\n\n### Historical Solutions Reference (Similar Errors Resolved in this Workspace):\n';
      matches.forEach((match, index) => {
        prompt += `\n[Example #${index + 1}]:
- **Error encountered:**
\`\`\`
${match.error}
\`\`\`
- **Files changed:** ${match.files.join(', ')}
- **How it was solved (Applied Patch):**
\`\`\`diff
${match.diff}
\`\`\`\n`;
      });
      return prompt;
    } catch (e) {
      return '';
    }
  }

  private static findMatchingFixes(errorText: string, memory: ErrorFixRecord[]): ErrorFixRecord[] {
    const errorLower = errorText.toLowerCase();
    const tscCodeMatch = errorLower.match(/\bts\d{4}\b/);
    const tscCode = tscCodeMatch ? tscCodeMatch[0] : null;

    const scored = memory.map(rec => {
      let score = 0;
      const recLower = rec.error.toLowerCase();

      if (tscCode && recLower.includes(tscCode)) {
        score += 0.5;
      }

      const words1 = new Set(errorLower.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(w => w.length > 2));
      const words2 = new Set(recLower.split(/\s+/).map(w => w.replace(/[^a-z0-9]/g, '')).filter(w => w.length > 2));
      
      let intersection = 0;
      words1.forEach(w => {
        if (words2.has(w)) intersection++;
      });
      const union = words1.size + words2.size - intersection;
      const jaccard = union > 0 ? (intersection / union) : 0;
      score += jaccard;

      return { rec, score };
    });

    return scored
      .filter(x => x.score > 0.35)
      .sort((a, b) => b.score - a.score)
      .map(x => x.rec)
      .slice(0, 2);
  }

  public static generateDiffString(fileBackups: Record<string, string>, workspaceRoot: string): string {
    let diffStr = '';
    for (const [fileAbs, originalContent] of Object.entries(fileBackups)) {
      try {
        if (fs.existsSync(fileAbs)) {
          const currentContent = fs.readFileSync(fileAbs, 'utf8');
          if (currentContent !== originalContent) {
            const relPath = path.relative(workspaceRoot, fileAbs).replace(/\\/g, '/');
            diffStr += `--- a/${relPath}\n+++ b/${relPath}\n`;
            
            const diffLines = DiffHandler.generateLineDiff(originalContent, currentContent);
            diffLines.forEach((line: any) => {
              if (line.type === 'added') {
                diffStr += `+ ${line.text}\n`;
              } else if (line.type === 'removed') {
                diffStr += `- ${line.text}\n`;
              }
            });
            diffStr += '\n';
          }
        }
      } catch {}
    }
    return diffStr.trim();
  }
}
