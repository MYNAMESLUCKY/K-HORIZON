import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AIService } from './ai-service';
import { ChatMessage } from './types';

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
