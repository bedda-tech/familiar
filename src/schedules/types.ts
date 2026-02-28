/** Schedule entity -- defines when an agent runs and with what prompt. */
export interface Schedule {
  id: string;
  agent_id: string;
  name: string | null;
  schedule: string; // cron expression or "every:30m"
  timezone: string;
  prompt: string;
  enabled: number; // 0 or 1
  created_at: string;
  updated_at: string;
}

export interface CreateScheduleInput {
  id: string;
  agent_id: string;
  name?: string;
  schedule: string;
  timezone?: string;
  prompt: string;
  enabled?: boolean;
}

export interface UpdateScheduleInput {
  agent_id?: string;
  name?: string | null;
  schedule?: string;
  timezone?: string;
  prompt?: string;
  enabled?: boolean;
}
