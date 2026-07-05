import { MessageBroker } from './message-broker';
import type { SidebarProvider } from '../sidebar-provider';
import { AgentLearningManager } from '../learning-manager';

export function registerLearningHandlers(broker: MessageBroker, provider: SidebarProvider): void {
  broker.on('requestAgentLearnings', async () => {
    const workspaceRoot = provider.getWorkspaceRoot();
    const learnings = await AgentLearningManager.loadLearnings(workspaceRoot);
    provider.postMessage({ type: 'agentLearnings', learnings });
  });

  broker.on('saveAgentLearning', async (data) => {
    const workspaceRoot = provider.getWorkspaceRoot();
    const newLearning = await AgentLearningManager.saveLearning(workspaceRoot, {
      source: data.source || 'user_correction',
      mistake: data.mistake,
      correction: data.correction,
      modelId: data.modelId
    });
    provider.postMessage({ type: 'learningAdded', learning: newLearning });
  });

  broker.on('deleteAgentLearning', async (data) => {
    const workspaceRoot = provider.getWorkspaceRoot();
    await AgentLearningManager.deleteLearning(workspaceRoot, data.id);
    const learnings = await AgentLearningManager.loadLearnings(workspaceRoot);
    provider.postMessage({ type: 'agentLearnings', learnings });
  });
}
