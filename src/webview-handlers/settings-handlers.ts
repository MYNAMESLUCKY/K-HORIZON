import { MessageBroker } from './message-broker';
import type { SidebarProvider } from '../sidebar-provider';

/**
 * Registers settings-domain message handlers:
 *   requestSettings, requestWorkspaceHealth, updateActiveModel, saveAgentProfiles
 */
export function registerSettingsHandlers(broker: MessageBroker, provider: SidebarProvider): void {
  broker.on('requestSettings', () => {
    provider.sendSettings();
  });

  broker.on('requestWorkspaceHealth', async () => {
    await provider.sendWorkspaceHealth();
  });

  broker.on('updateActiveModel', async (data) => {
    await provider.updateActiveModelInSettings(data.modelId, data.provider);
  });

  broker.on('saveAgentProfiles', async (data) => {
    await provider.saveAgentProfiles(data.profiles || []);
  });
}
