import { MessageBroker } from './message-broker';
import type { SidebarProvider } from '../sidebar-provider';

/**
 * Registers file-domain message handlers:
 *   openFile, createNewFile, insertCode, insertTerminal, openFilePicker
 */
export function registerFileHandlers(broker: MessageBroker, provider: SidebarProvider): void {
  broker.on('openFile', async (data) => {
    await provider.openFile(data.filePath);
  });

  broker.on('createNewFile', async (data) => {
    await provider.createNewFile(data.code, data.language);
  });

  broker.on('insertCode', (data) => {
    provider.insertCode(data.code);
  });

  broker.on('insertTerminal', (data) => {
    provider.insertTerminal(data.code);
  });

  broker.on('openFilePicker', async () => {
    await provider.handleOpenFilePicker();
  });
}
