/** Events emitted by claude -p --output-format stream-json */

export interface AssistantMessageEvent {
  type: "assistant";
  subtype: "message";
  session_id: string;
  message: {
    type: "message";
    id: string;
    role: "assistant";
    content: ContentBlock[];
    model: string;
    stop_reason: string | null;
  };
}

export interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: ContentBlock;
}

export interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: {
    type: "text_delta" | "thinking_delta";
    text?: string;
    thinking?: string;
  };
}

export interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface ResultEvent {
  type: "result";
  subtype: "success" | "error" | "error_max_turns";
  session_id: string;
  cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  result: string;
}

export interface SystemEvent {
  type: "system";
  subtype: string;
  message: string;
  session_id?: string;
}

export type StreamEvent =
  | AssistantMessageEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | ResultEvent
  | SystemEvent;

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface BackendResult {
  text: string;
  sessionId: string;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  isError: boolean;
}

/** What we yield during streaming */
export interface TextDelta {
  type: "text_delta";
  text: string;
}

export interface ToolUseInfo {
  type: "tool_use";
  name: string;
}

export interface ThinkingDelta {
  type: "thinking";
  text: string;
}

export interface StreamDone {
  type: "done";
  result: BackendResult;
}

export type StreamYield = TextDelta | ToolUseInfo | ThinkingDelta | StreamDone;
