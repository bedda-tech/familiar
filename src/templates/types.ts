/** Prompt template -- a reusable text block for agent prompts, task descriptions, etc. */
export interface Template {
  id: number;
  name: string;
  category: string; // 'agent-prompt' | 'system-prompt' | 'task-description' | 'other'
  description: string | null;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface CreateTemplateInput {
  name: string;
  category: string;
  description?: string;
  content: string;
}

export interface UpdateTemplateInput {
  name?: string;
  category?: string;
  description?: string | null;
  content?: string;
}
