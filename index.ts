/**
 * Subdermial - Multi-agent orchestrator for pi
 *
 * Turns pi into a conductor that spawns, monitors, and coordinates
 * subagents running in isolated context windows.
 *
 * Commands:
 *   /agent     - Spawn a single subagent for a specific task
 *   /goal      - Set a multi-step goal with automated orchestration
 *   /open-agent - Reopen an agent's session in a new terminal
 *
 * Tools:
 *   spawn_agent - LLM-callable tool for the orchestrator to spawn subagents
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./agent-manager";
import { GoalEngine } from "./goal-engine";
import { loadNamePool } from "./name-generator";
import { createWidgetRenderer } from "./widget";
import { findStoreEntry, restoreStore, serializeStore, CUSTOM_TYPE } from "./session-store";
import { createSpawnAgentTool } from "./tools/spawn-agent";
import { createAgentCommand } from "./commands/agent";
import { createGoalCommand } from "./commands/goal";
import { createOpenAgentCommand } from "./commands/open-agent";
import { initLogger, info, error, closeLogger } from "./logger";

export default function (pi: ExtensionAPI) {
  // Set up directories
  const agentDir = getAgentDir();
  const subdermialDir = path.join(agentDir, "subdermial");
  const sessionsDir = path.join(subdermialDir, "sessions");
  const goalsDir = path.join(subdermialDir, "goals");
  const namesPath = path.join(subdermialDir, "names.json");

  // Initialize logger
  initLogger(subdermialDir);

  // Load name pool
  loadNamePool(namesPath);

  // Create the agent manager
  const manager = new AgentManager(pi, {
    sessionsDir,
    goalsDir,
    defaultModel: "anthropic/claude-sonnet-4-5",
    maxConcurrency: 4,
    maxAgents: 20,
    retryOnError: 0,
    defaultProfile: "worker",
  });

  // Create the goal engine
  const goalEngine = new GoalEngine(manager, pi);

  // Widget renderer (initialized on session_start)
  let widget: ReturnType<typeof createWidgetRenderer> | null = null;
  let ctx: ExtensionContext | null = null;

  function initWidget(context: ExtensionContext): void {
    ctx = context;
    manager.setContext(context);

    widget = createWidgetRenderer(
      manager,
      (name, lines) => context.ui.setWidget(name, lines),
      (name, text) => context.ui.setStatus(name, text),
    );

    manager.setOnStateChange(() => {
      if (widget) widget.update();
    });

    widget.update();
  }

  // Register tools
  pi.registerTool(createSpawnAgentTool(pi, manager, goalEngine));

  // Register commands
  pi.registerCommand("agent", createAgentCommand(manager));
  pi.registerCommand("goal", createGoalCommand(manager, goalEngine));
  pi.registerCommand("open-agent", createOpenAgentCommand(manager));

  // Also register a /kill-agent command dynamically
  pi.registerCommand("kill-agent", {
    description: "Kill a subdermial agent by name",
    handler: async (args: string, cmdCtx) => {
      const name = args.trim();
      if (!name) {
        cmdCtx.ui.notify("Usage: /kill-agent <agent-name>", "info");
        return;
      }

      const agent = manager.agents.get(name);
      if (!agent) {
        // Try to find by display name
        const found = [...manager.agents.values()].find((a) => a.displayName === name);
        if (!found) {
          cmdCtx.ui.notify(`No agent named "${name}" found`, "error");
          return;
        }

        const ok = await cmdCtx.ui.confirm(
          "Kill agent?",
          `Kill ${found.displayName} (${found.status})?`,
        );
        if (!ok) return;

        manager.killAgent(found.id, "Killed by user");
        cmdCtx.ui.notify(`Killed agent: ${found.displayName}`, "info");
        return;
      }

      const ok = await cmdCtx.ui.confirm(
        "Kill agent?",
        `Kill ${agent.displayName} (${agent.status})?`,
      );
      if (!ok) return;

      manager.killAgent(agent.id, "Killed by user");
      cmdCtx.ui.notify(`Killed agent: ${agent.displayName}`, "info");
    },
  });

  // Register /agents command to list all agents
  pi.registerCommand("agents", {
    description: "List all subdermial agents in this session",
    handler: async (_args: string, cmdCtx) => {
      const agents = [...manager.agents.values()];
      if (agents.length === 0) {
        cmdCtx.ui.notify("No agents in this session", "info");
        return;
      }

      const summary = manager.getAgentSummary();
      // Split into chunks to avoid overflow
      const lines = summary.split("\n");
      const notifyChunks = [];
      let current = "";
      for (const line of lines) {
        if (current.length + line.length > 500) {
          notifyChunks.push(current);
          current = line + "\n";
        } else {
          current += line + "\n";
        }
      }
      if (current) notifyChunks.push(current);

      // Show first chunk, note rest
      cmdCtx.ui.notify(notifyChunks[0] || "No agents", "info");
      if (notifyChunks.length > 1) {
        cmdCtx.ui.notify(`... and ${notifyChunks.length - 1} more lines`, "info");
      }
    },
  });

  // Inject goal context into system prompt for the orchestrator
  pi.on("before_agent_start", async (event) => {
    if (manager.activeGoal) {
      const goalContext = goalEngine.getOrchestratorGoalContext();
      if (goalContext) {
        return {
          systemPrompt: event.systemPrompt + "\n\n" + goalContext,
        };
      }
    }
  });

  // Session lifecycle
  pi.on("session_start", async (event, context) => {
    info(`Session started: reason=${event.reason}`);

    // Restore state from previous session
    const entries = context.sessionManager.getEntries();
    const stored = findStoreEntry(entries);
    const restored = restoreStore(stored);

    // Restore agents
    manager.agents = restored.agents;
    manager.usedNames = restored.usedNames;

    // Re-apply active goal
    if (restored.activeGoal) {
      // Check if goal was completed/failed before restart
      const goalStatus = restored.activeGoal.status;
      if (goalStatus === "active") {
        manager.activeGoal = restored.activeGoal;
        info(`Restored active goal: ${restored.activeGoal.id}`);
      }
    }

    // Initialize widget
    initWidget(context);

    // If this is a resume with an active goal, notify the user
    if (event.reason === "resume" && manager.activeGoal) {
      context.ui.notify(
        `Active goal restored: ${manager.activeGoal.description.slice(0, 60)}... Use /goal to check progress.`,
        "info",
      );
    }

    // Persist restored state (with killed agents updated by restoreStore)
    manager.persist();

    info(
      `Session ready: ${manager.agents.size} agents, goal: ${manager.activeGoal ? "active" : "none"}`,
    );
  });

  pi.on("session_shutdown", async (event) => {
    info(`Session shutdown: reason=${event.reason}`);

    // Persist one last time
    manager.persist();

    // Clear widget
    if (widget) widget.clear();

    closeLogger();
  });

  // Handle reload
  pi.on("session_start", async (event, context) => {
    if (event.reason === "reload") {
      info("Extension reloaded");
      initWidget(context);
    }
  });

  info("Subdermial extension loaded");
}