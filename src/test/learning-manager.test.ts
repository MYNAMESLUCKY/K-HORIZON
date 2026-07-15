import { describe, expect, it, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentLearningManager } from '../learning-manager';
import { AIService } from '../ai-service';

describe('AgentLearningManager', () => {
  const tempDirs: string[] = [];

  function makeTempWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {}
    }
  });

  it('correctly loads, saves, and deletes learning rules', async () => {
    const workspace = makeTempWorkspace();

    // 1. Initial should be empty
    let learnings = await AgentLearningManager.loadLearnings(workspace);
    expect(learnings).toHaveLength(0);

    // 2. Save a learning
    const saved = await AgentLearningManager.saveLearning(workspace, {
      source: 'user_correction',
      mistake: 'used wrong database port',
      correction: 'always check default database port'
    });

    expect(saved.id).toBeDefined();
    expect(saved.mistake).toBe('used wrong database port');

    learnings = await AgentLearningManager.loadLearnings(workspace);
    expect(learnings).toHaveLength(1);
    expect(learnings[0].correction).toBe('always check default database port');

    // 3. Render prompt
    const prompt = await AgentLearningManager.loadLearningsAsPrompt(workspace);
    expect(prompt).toContain('Rule #1');
    expect(prompt).toContain('Mistake / Trigger: used wrong database port');

    // 4. Delete the learning
    await AgentLearningManager.deleteLearning(workspace, saved.id);
    learnings = await AgentLearningManager.loadLearnings(workspace);
    expect(learnings).toHaveLength(0);
  });

  it('reflects and learns successfully from chat history', async () => {
    const workspace = makeTempWorkspace();

    const mockResponse = JSON.stringify({
      hasLearning: true,
      mistake: 'called nonexistent tool sequential_thinking',
      correction: 'always use mcp__SequentialThinking__sequentialthinking'
    });

    const mockStreamResponse = vi.spyOn(AIService, 'streamResponse').mockResolvedValue(mockResponse);

    try {
      const chatHistory = [
        { role: 'user', content: 'run sequential thinking', timestamp: Date.now() },
        { role: 'assistant', content: 'I will call sequential_thinking tool.', timestamp: Date.now() }
      ];

      const learning = await AgentLearningManager.reflectAndLearn(
        workspace,
        chatHistory,
        0,
        0,
        'mock-model'
      );

      expect(learning).not.toBeNull();
      expect(learning?.mistake).toBe('called nonexistent tool sequential_thinking');
      expect(learning?.correction).toBe('always use mcp__SequentialThinking__sequentialthinking');

      const learnings = await AgentLearningManager.loadLearnings(workspace);
      expect(learnings).toHaveLength(1);
      expect(learnings[0].correction).toBe('always use mcp__SequentialThinking__sequentialthinking');
    } finally {
      mockStreamResponse.mockRestore();
    }
  });
});
