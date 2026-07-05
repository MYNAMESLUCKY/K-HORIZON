import { MessageBroker } from './message-broker';
import type { SidebarProvider } from '../sidebar-provider';

/**
 * Registers tool-approval-domain message handlers:
 *   toolApprovalResponse, toolChecklistResponse
 */
export function registerToolHandlers(broker: MessageBroker, provider: SidebarProvider): void {
  broker.on('toolApprovalResponse', (data) => {
    provider.resolveToolDebug({
      approved: data.approved,
      arguments: data.arguments,
      skipped: data.skipped,
      mocked: data.mocked,
      mockValue: data.mockValue
    });
    provider.handleToolApprovalResponse(data.toolCallId, data.approved);
  });

  broker.on('toolChecklistResponse', (data) => {
    provider.resolveChecklist(data.approvedCalls);
  });
}
