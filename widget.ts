/**
 * TUI widget for displaying subdermial agent status in the orchestrator.
 *
 * Renders a compact list of all agents above the editor, showing:
 * - Status icon (⏳ running, ✓ done, ✗ errored, ☠ killed, ◉ open)
 * - Agent name + profile
 * - Elapsed time / status
 * - Error message (if errored)
 */

import type { AgentManager } from "./agent-manager";
import { statusIcon } from "./agent-manager";
import type { AgentState, GoalState } from "./types";

export interface WidgetRenderer {
  /** Update the widget with current state */
  update(): void;
  /** Clear the widget */
  clear(): void;
}

/**
 * Create a widget renderer bound to the pi ExtensionAPI.
 * Must be called after session_start when ctx.ui is available.
 */
export function createWidgetRenderer(
  manager: AgentManager,
  setWidget: (name: string, lines: string[] | undefined) => void,
  setStatus: (name: string, text: string | undefined) => void,
): WidgetRenderer {
  const WIDGET_NAME = "subdermial-agents";
  const STATUS_NAME = "subdermial";

  function render(): { widgetLines: string[] | undefined; statusText: string | undefined } {
    const agents = [...manager.agents.values()];
    const activeGoal = manager.activeGoal;

    if (agents.length === 0 && !activeGoal) {
      return { widgetLines: undefined, statusText: undefined };
    }

    // Count by status
    const running = agents.filter((a) => a.status === "running" || a.status === "pending").length;
    const open = agents.filter((a) => a.status === "open").length;
    const errored = agents.filter((a) => a.status === "errored").length;
    const done = agents.filter((a) => a.status === "completed" || a.status === "dead").length;

    // Status line text
    const statusParts: string[] = [];
    if (running > 0) statusParts.push(`⏳${running}`);
    if (open > 0) statusParts.push(`◉${open}`);
    if (done > 0) statusParts.push(`✓${done}`);
    if (errored > 0) statusParts.push(`✗${errored}`);
    const statusText = statusParts.length > 0 ? `agents: ${statusParts.join(" ")}` : undefined;

    // Widget lines
    const widgetLines: string[] = [];
    widgetLines.push("subdermial-agents ───────────────────────────");

    // Goal status
    if (activeGoal) {
      const goalStatus = activeGoal.status === "active" ? "⏳" : activeGoal.status === "completed" ? "✓" : "✗";
      const completedSteps = activeGoal.steps.filter((s) => s.status === "completed").length;
      widgetLines.push(`  ${goalStatus} goal: ${activeGoal.description.slice(0, 50)}... [${completedSteps}/${activeGoal.steps.length} steps]`);
    }

    // Show running/errored first, then open, then completed
    const sorted = [...agents].sort((a, b) => {
      const order: Record<string, number> = { running: 0, pending: 0, errored: 1, open: 2, completed: 3, killed: 3, dead: 3 };
      return (order[a.status] ?? 4) - (order[b.status] ?? 4);
    });

    const maxShow = 10;
    let shown = 0;

    for (const agent of sorted) {
      if (shown >= maxShow) break;
      if (agent.status === "dead") continue; // Don't clutter with dead agents

      const icon = statusIcon(agent.status);
      const elapsed = agent.endTime
        ? `${Math.round((agent.endTime - agent.startTime) / 1000)}s`
        : `${Math.round((Date.now() - agent.startTime) / 1000)}s`;

      let line = `  ${icon} ${agent.displayName}`;
      if (agent.profile && agent.profile !== "worker") {
        line += ` (${agent.profile})`;
      }
      line += ` ${elapsed}`;

      if (agent.status === "errored" && agent.error) {
        const errShort = agent.error.length > 30 ? agent.error.slice(0, 30) + "..." : agent.error;
        line += ` - ${errShort}`;
      }

      widgetLines.push(line);
      shown++;
    }

    const remaining = agents.length - shown;
    if (remaining > 0) {
      widgetLines.push(`  ... and ${remaining} more`);
    }

    widgetLines.push("───────────────────────────────────────────────");

    return { widgetLines, statusText };
  }

  return {
    update() {
      const { widgetLines, statusText } = render();
      setWidget(WIDGET_NAME, widgetLines);
      setStatus(STATUS_NAME, statusText);
    },
    clear() {
      setWidget(WIDGET_NAME, undefined);
      setStatus(STATUS_NAME, undefined);
    },
  };
}
