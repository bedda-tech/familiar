/**
 * MessageBus -- lightweight pub/sub for cross-channel message routing.
 *
 * All channels (Telegram, Dashboard, Slack, etc.) emit events here.
 * Subscribers (WsServer, TelegramChannel) react to events from other channels.
 */

export type BusSource = "telegram" | "dashboard" | "slack" | "discord" | "tui";

export type BusEvent =
  | { type: "message"; role: "user" | "assistant"; text: string; source: BusSource; chatId: string }
  | { type: "draft"; text: string; done: boolean; source: BusSource }
  | { type: "typing"; source: BusSource };

export class MessageBus {
  private listeners = new Set<(event: BusEvent) => void>();

  emit(event: BusEvent): void {
    for (const fn of this.listeners) fn(event);
  }

  /** Register a listener. Returns an unsubscribe function. */
  on(fn: (event: BusEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
