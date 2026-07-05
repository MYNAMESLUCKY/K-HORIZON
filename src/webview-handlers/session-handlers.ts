import { MessageBroker } from './message-broker';
import type { SidebarProvider } from '../sidebar-provider';
import { DBClient } from '../db-client';

/**
 * Registers session-domain message handlers:
 *   requestWorkspaceFiles (initial mount + session load),
 *   loadChatSessions, deleteSession, switchSession
 */
export function registerSessionHandlers(broker: MessageBroker, provider: SidebarProvider): void {
  broker.on('requestWorkspaceFiles', async () => {
    provider.sendWorkspaceFiles();
    provider.sendAgentProfiles();
    provider.sendSettings();
    try {
      const pool = await DBClient.initialize();
      if (provider.getActiveSessionId() === 'default') {
        const lastSessionRes = await pool.query(
          'SELECT session_id FROM chat_history ORDER BY timestamp DESC LIMIT 1'
        );
        if (lastSessionRes.rows.length > 0) {
          await provider.setActiveSessionId(lastSessionRes.rows[0].session_id);
        }
      }
      await provider.loadChatHistoryFromDB();
      await provider.loadChatSessions();
    } catch (err) {
      console.error('Failed to load chat history on mount:', err);
    }
  });

  broker.on('loadChatSessions', async () => {
    await provider.loadChatSessions();
  });

  broker.on('deleteSession', async (data) => {
    await provider.deleteSession(data.sessionId);
  });

  broker.on('switchSession', async (data) => {
    await provider.switchSession(data.sessionId);
  });
}
