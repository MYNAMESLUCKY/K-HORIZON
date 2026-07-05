import { MessageBroker } from './message-broker';
import type { SidebarProvider } from '../sidebar-provider';

/**
 * Registers chat-domain message handlers:
 *   sendMessage, cancelAgent, newChat, compactSession, applyCodeBlock
 */
export function registerChatHandlers(broker: MessageBroker, provider: SidebarProvider): void {
  broker.on('sendMessage', async (data) => {
    await provider.handleUserMessage(
      data.prompt,
      data.files,
      data.useWorkspaceContext,
      data.autoApprove,
      data.role,
      data.autoCompile,
      data.pinnedFiles,
      data.autoTest,
      data.stepDebug,
      data.isSplitScreen,
      data.modelId2,
      data.provider2
    );
  });

  broker.on('improvePrompt', async (data) => {
    await provider.improvePrompt(data.prompt);
  });

  broker.on('cancelAgent', () => {
    provider.cancelAgent();
  });

  broker.on('newChat', () => {
    provider.newChat();
  });

  broker.on('compactSession', async () => {
    await provider.compactSession();
  });

  broker.on('applyCodeBlock', (data) => {
    provider.applyCodeBlock(data.code);
  });
}
