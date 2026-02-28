/**
 * WebSocket event types for real-time dashboard communication.
 */

export type WsEvent =
  | { type: "schedule:started"; scheduleId: string; agentId: string }
  | { type: "schedule:completed"; scheduleId: string; agentId: string; durationMs: number; costUsd: number; isError: boolean }
  | { type: "task:updated"; task: Record<string, unknown> }
  | { type: "task:claimed"; taskId: number; agent: string }
  | { type: "task:completed"; taskId: number; result: string }
  | { type: "agent:status"; agentId: string; status: string }
  | { type: "activity"; entry: ActivityEntry }
  | { type: "chat:message"; role: string; text: string }
  | { type: "chat:draft"; text: string; done: boolean }
  | { type: "connected"; clientId: string };

export interface ActivityEntry {
  id?: number;
  type: string;
  agent_id?: string;
  schedule_id?: string;
  task_id?: number;
  summary: string;
  details?: string;
  created_at?: string;
}
