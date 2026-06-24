/**
 * /goal command - set a multi-step goal for the orchestrator.
 *
 * Usage:
 *   /goal "implement Redis caching layer for the API"
 *   /goal @./tasks/redis-plan.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager";
import type { GoalEngine } from "../goal-engine";
import { info, error } from "../logger";

export function createGoalCommand(manager: AgentManager, goalEngine: GoalEngine) {
  return {
    description: "Set a goal for the orchestrator to achieve with subagents",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();

      if (!trimmed) {
        ctx.ui.notify(
          "Usage: /goal \"description of the goal\" or /goal @./path/to/goal.md",
          "info",
        );
        return;
      }

      let description = trimmed;

      // If starts with @, read from file
      if (trimmed.startsWith("@")) {
        const filePath = trimmed.slice(1);
        const resolved = path.isAbsolute(filePath) ? filePath : path.join(ctx.cwd, filePath);
        try {
          description = fs.readFileSync(resolved, "utf-8").trim();
          if (!description) {
            ctx.ui.notify(`File ${filePath} is empty`, "error");
            return;
          }
        } catch {
          ctx.ui.notify(`Cannot read file: ${filePath}`, "error");
          return;
        }
      } else {
        // Remove surrounding quotes if present
        if (
          (description.startsWith('"') && description.endsWith('"')) ||
          (description.startsWith("'") && description.endsWith("'"))
        ) {
          description = description.slice(1, -1);
        }
      }

      if (manager.activeGoal) {
        const choice = await ctx.ui.confirm(
          "Active goal exists",
          `A goal is already active: "${manager.activeGoal.description}". Replace it?`,
        );
        if (!choice) {
          ctx.ui.notify("Goal creation canceled", "info");
          return;
        }
      }

      try {
        const config = manager.getConfig();
        const goal = await goalEngine.createGoal(description, config.goalsDir);

        ctx.ui.notify(`Goal created: ${goal.description.slice(0, 60)}...`, "info");

        // Send a crafted message to the orchestrator LLM to plan and execute the goal
        const orchestratorPrompt = `[SUB-DERMIAL GOAL ACTIVATED]

A goal has been set. Read the goal file at ${goal.goalPath} to understand the full objective.

## Your Task
1. Read ${goal.goalPath} to understand the goal
2. Edit it (using the edit tool) to expand it with:
   - Detailed, numbered steps to achieve the goal
   - Clear, measurable success criteria for each step
   - A strategy section describing which agent profiles/models to use and whether steps can run in parallel
3. Save progress to ${goal.progressPath} as you go
4. Use the \`spawn_agent\` tool to delegate each step to a subagent
   - For independent steps, call spawn_agent multiple times in ONE turn for parallel execution
   - Use the \`profile\` parameter to select the right agent type (scout for exploration, worker for implementation, planner for planning, reviewer for review)
   - Use cheaper/faster models for simple tasks (e.g. haiku for scouting)
5. After each agent completes, check the results and update progress.md
6. When ALL steps are completed AND all success criteria are met, mark the goal as complete

## Important
- Maximum 20 agents total across this goal
- If an agent errors, decide whether to retry (with same or different model/profile) or skip
- Write clear results to progress.md after each agent so the next agent has context
- Do NOT wait idly - plan multiple agent spawns proactively

Goal: ${goal.description}`;

        // Send as a steering message to inject into the conversation
        manager.pi.sendMessage(
          {
            customType: "subdermial-goal-activate",
            content: orchestratorPrompt,
            display: true,
          },
          { triggerTurn: true },
        );

        info(`/goal activated: ${goal.id}`);
      } catch (err: any) {
        error("/goal failed", err);
        ctx.ui.notify(`Failed to create goal: ${err.message}`, "error");
      }
    },
  };
}
