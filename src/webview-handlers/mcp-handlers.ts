import { MessageBroker } from './message-broker';
import type { SidebarProvider } from '../sidebar-provider';
import { MCPManager } from '../mcp-manager';

/**
 * Registers MCP-domain message handlers:
 *   getMcpServers, addMcpServer, deleteMcpServer
 */
export function registerMcpHandlers(broker: MessageBroker, provider: SidebarProvider): void {
  broker.on('getMcpServers', () => {
    provider.postMessage({ type: 'mcpServersList', servers: MCPManager.getServersStatus() });
  });

  broker.on('addMcpServer', async (data) => {
    try {
      await MCPManager.addServer({
        name: data.name,
        command: data.commandText,
        args: data.args || [],
        env: data.env
      });
      provider.postMessage({ type: 'mcpServersList', servers: MCPManager.getServersStatus(), success: true });
    } catch (err: any) {
      provider.postMessage({ type: 'mcpServersList', servers: MCPManager.getServersStatus(), error: err.message });
    }
  });

  broker.on('deleteMcpServer', async (data) => {
    try {
      await MCPManager.deleteServer(data.name);
      provider.postMessage({ type: 'mcpServersList', servers: MCPManager.getServersStatus(), success: true });
    } catch (err: any) {
      provider.postMessage({ type: 'mcpServersList', servers: MCPManager.getServersStatus(), error: err.message });
    }
  });

  broker.on('restartMcpServer', async (data) => {
    try {
      await MCPManager.restartServer(data.name);
      provider.postMessage({ type: 'mcpServersList', servers: MCPManager.getServersStatus(), success: true });
    } catch (err: any) {
      provider.postMessage({ type: 'mcpServersList', servers: MCPManager.getServersStatus(), error: err.message });
    }
  });
}
