/**
 * Generic typed message broker for decoupling webview message dispatch
 * from handler logic. Replaces monolithic switch blocks with a clean
 * register-and-dispatch pattern.
 */
export type MessageHandler = (data: any) => void | Promise<void>;

export class MessageBroker {
  private handlers = new Map<string, MessageHandler>();

  /**
   * Register a handler for a specific command string.
   * Overwrites any previously registered handler for the same command.
   */
  on(command: string, handler: MessageHandler): void {
    this.handlers.set(command, handler);
  }

  /**
   * Dispatch an incoming message to its registered handler.
   * Logs a warning if no handler is registered for the command.
   */
  async dispatch(data: { command: string; [key: string]: any }): Promise<void> {
    const handler = this.handlers.get(data.command);
    if (handler) {
      await handler(data);
    } else {
      console.warn(`[MessageBroker] Unhandled command: ${data.command}`);
    }
  }
}
