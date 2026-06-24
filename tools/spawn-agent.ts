/**
 * spawn_agent tool - callable by the orchestrator LLM.
 *
 * The orchestrator uses this to spawn subagents for specific tasks.
 * Blocks until the agent completes.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager";
import type { GoalEngine } from "../goal-engine";
import { info, error } from "../logger";

export function createSpawnAgentTool(pi: ExtensionAPI, manager: AgentManager, goalEngine: GoalEngine) {
  return {
    name: "spawn_agent",
    label: "Spawn Agent",
    description: [
      "Spawn a subdermial agent with isolated context to handle a delegated task.",
      "The agent runs in a separate pi process and returns results when done.",
      "Use multiple spawn_agent calls in one turn for parallel execution.",
      "Max 20 agents per session.",
    ].join(" "),
    promptSnippet: "Spawn a subagent to handle a delegated task",
    promptGuidelines: [
      "Use spawn_agent to delegate work to isolated subagents. For parallel independent tasks, call spawn_agent multiple times in one turn.",
      "Each spawn_agent blocks until the agent completes. The orchestrator should not wait doing nothing - plan multiple agent spawns.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Detailed task for the agent to complete" }),
      tools: Type.Optional(
        Type.String({
          description: "Comma-separated tool list (e.g. 'read,grep,find,ls,bash'). Defaults to all tools.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: "Model to use (e.g. 'anthropic/claude-haiku-4-5'). Defaults to the configured default model.",
        }),
      ),
      profile: Type.Optional(
        Type.String({
          description: "Agent profile to use (e.g. 'scout', 'worker', 'planner', 'reviewer')",
        }),
      ),
    }),

    async execute(
      _toolCallId: string,
      params: { task: string; tools?: string; model?: string; profile?: string },
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: any,
    ) {
      const toolsList = params.tools
        ? params.tools.split(",").map((t: string) => t.trim()).filter(Boolean)
        : undefined;

      const goal = manager.activeGoal;
      let systemPrompt: string | undefined;

      if (goal) {
        systemPrompt = goalEngine.buildGoalAgentPrompt(goal, params.task, params.profile);
      }

      info(`LLM requesting spawn_agent: ${params.task.slice(0, 80)}...`);

      try {
        const agent = await manager.spawnAgent({
          task: params.task,
          tools: toolsList,
          model: params.model,
          profile: params.profile,
          systemPrompt,
          goalId: goal?.id,
        });

        // Wait for agent to complete (poll with abort support)
        const startTime = Date.now();
        const maxWait = 30 * 60 * 1000; // 30 minute max wait
        let lastUpdate = 0;

        while (true) {
          if (signal?.aborted) {
            manager.killAgent(agent.id, "Aborted by orchestrator");
            return {
              content: [{ type: "text", text: `Agent ${agent.id} was aborted.` }],
              isError: true,
            };
          }

          const current = manager.agents.get(agent.id);
          if (!current) {
            return {
              content: [{ type: "text", text: `Agent ${agent.id} was removed unexpectedly.` }],
              isError: true,
            };
          }

          if (current.status === "completed") {
            // Append to progress if in goal mode
            if (goal && current.result) {
              goalEngine.appendProgress(agent.id, current.result, true);
            }

            return {
              content: [
                {
                  type: "text",
                  text: `[${current.displayName} - ✓ completed]\n\n${current.result || taskSummary(current)}`,
                },
              ],
              details: {
                agentId: current.id,
                displayName: current.displayName,
                status: current.status,
                turns: current.turns,
                usage: current.usage,
                model: current.model,
              },
            };
          }

          if (current.status === "errored") {
            // Append to progress if in goal mode
            if (goal) {
              goalEngine.appendProgress(agent.id, current.error || "Unknown error", false);
            }

            return {
              content: [
                {
                  type: "text",
                  text: `[${current.displayName} - ✗ errored]\n\n**Error:** ${current.error || "Unknown error"}`,
                },
              ],
              isError: true,
              details: {
                agentId: current.id,
                displayName: current.displayName,
                status: current.status,
                error: current.error,
              },
            };
          }

          if (current.status === "killed") {
            return {
              content: [
                { type: "text", text: `[${current.displayName} - ☠ killed]\n\n${current.error || "Killed"}` },
              ],
              isError: true,
            };
          }

          if (Date.now() - startTime > maxWait) {
            manager.killAgent(agent.id, "Timed out");
            return {
              content: [{ type: "text", text: `Agent ${agent.id} timed out after 30 minutes.` }],
              isError: true,
            };
          }

          // Streaming update every 3 seconds
          const now = Date.now();
          if (now - lastUpdate > 3000 && onUpdate) {
            lastUpdate = now;
            const elapsed = Math.round((now - agent.startTime) / 1000);
            onUpdate({
              content: [{ type: "text", text: `⏳ ${agent.displayName} working... (${elapsed}s, ${agent.turns} turns)` }],
              details: { agentId: agent.id, status: agent.status, turns: agent.turns },
            });
          }

          await sleep(500);
        }
      } catch (err: any) {
        error("spawn_agent failed", err);
        return {
          content: [{ type: "text", text: `Failed to spawn agent: ${err.message}` }],
          isError: true,
        };
      }
    },
  };
}

function taskSummary(agent: import("../types").AgentState): string {
  return `Task completed in ${agent.turns} turns.` +
    `\nCost: $${agent.usage.cost.toFixed(4)}` +
    `\nTokens: ↑${formatTokens(agent.usage.input)} ↓${formatTokens(agent.usage.output)}`;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
