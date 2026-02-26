/**
 * AgentStore — read-only agent state interface for the REST API.
 *
 * Wraps AgentManager to expose agent state without coupling the API
 * layer to the full manager internals.
 */

import type { AgentManager } from "./manager.js";
import type { SubagentRecord } from "./registry.js";

export interface AgentStateSnapshot {
  active: SubagentRecord[];
  recent: SubagentRecord[];
  activeCount: number;
}

export class AgentStore {
  constructor(private manager: AgentManager) {}

  /** Get a snapshot of current agent state. */
  getState(): AgentStateSnapshot {
    const active = this.manager.listActive();
    const recent = this.manager.listRecent(undefined, 20);
    return { active, recent, activeCount: active.length };
  }

  /** Get a specific agent by ID (prefix match). */
  getAgent(idPrefix: string): SubagentRecord | null {
    return this.manager.getInfo(idPrefix);
  }
}
