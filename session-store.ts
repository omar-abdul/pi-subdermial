/**
 * Session persistence for subdermial agent metadata.
 *
 * Uses pi.appendEntry() to store agent state in the orchestrator's session.
 * This allows full resumption of agent state when the orchestrator session is reloaded.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentState, GoalState, SubdermialStore } from "./types";

const CUSTOM_TYPE = "subdermial-store";
const STORE_VERSION = 1;

/**
 * Create an empty store.
 */
export function createEmptyStore(): SubdermialStore {
  return {
    version: STORE_VERSION,
    agents: {},
    activeGoal: null,
    completedGoals: [],
    usedNames: [],
  };
}

/**
 * Find the most recent subdermial store entry in the session.
 */
export function findStoreEntry(entries: readonly SessionEntry[]): SubdermialStore | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      "customType" in entry &&
      entry.customType === CUSTOM_TYPE &&
      "data" in entry &&
      typeof (entry as any).data === "object"
    ) {
      const data = (entry as any).data as SubdermialStore;
      if (data.version === STORE_VERSION) {
        return data;
      }
    }
  }
  return null;
}

/**
 * Restore agent state from store entry.
 */
export function restoreStore(
  store: SubdermialStore | null,
): { agents: Map<string, AgentState>; activeGoal: GoalState | null; usedNames: Set<string> } {
  const agents = new Map<string, AgentState>();
  const usedNames = new Set<string>();

  if (store) {
    for (const [id, agent] of Object.entries(store.agents)) {
      // Mark previously running agents as killed (process won't survive restart)
      if (agent.status === "running" || agent.status === "pending" || agent.status === "open") {
        agent.status = "killed";
        agent.error = "Orchestrator restarted - agent process terminated";
        agent.endTime = Date.now();
        delete agent.pid;
        delete agent.terminalPid;
        agent.terminalStatus = "closed";
      }
      agents.set(id, agent);
    }
    for (const name of store.usedNames) {
      usedNames.add(name);
    }
    return { agents, activeGoal: store.activeGoal, usedNames };
  }

  return { agents, activeGoal: null, usedNames };
}

/**
 * Serialize current state for persistence.
 */
export function serializeStore(
  agents: Map<string, AgentState>,
  activeGoal: GoalState | null,
  usedNames: Set<string>,
): SubdermialStore {
  const agentsObj: Record<string, AgentState> = {};
  for (const [id, agent] of agents) {
    agentsObj[id] = { ...agent };
  }
  return {
    version: STORE_VERSION,
    agents: agentsObj,
    activeGoal: activeGoal ? { ...activeGoal } : null,
    completedGoals: activeGoal?.status === "completed" || activeGoal?.status === "failed" ? [activeGoal] : [],
    usedNames: Array.from(usedNames),
  };
}

export { CUSTOM_TYPE };
