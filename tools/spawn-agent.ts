/**
 * spawn_agent tool - callable by the orchestrator LLM.
 *
 * The orchestrator uses this to spawn subagents for specific tasks.
 * Blocks until the agent completes.
 */

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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
      ctx: ExtensionCommandContext,
    ) {
      const toolsList = params.tools
        ? params.tools.split(",").map((t: string) => t.trim()).filter(Boolean)
        : undefined;

      // Resolve API key for the agent's model
      let apiKey: string | undefined;
      try {
        const model = params.model || manager.getConfig().defaultModel;
        const [provider, modelId] = model.includes("/") ? model.split("/", 2) : ["anthropic", model];
        // Try to get the resolved model from the registry
        const resolvedModel = ctx.modelRegistry?.find?.(provider, modelId);
        if (resolvedModel) {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolvedModel);
          if (auth.ok && auth.apiKey) {
            apiKey = auth.apiKey;
          }
        }
      } catch {
        // Will fall back to env vars
      }

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
          apiKey,
          notifyOrchestrator: false,
        });

        const completed = await waitWithAbort(manager, agent.id, signal, onUpdate);
        if (completed.status === "completed") {
          if (goal && completed.result) goalEngine.appendProgress(agent.id, completed.result, true);
          return {
            content: [{
              type: "text",
              text: `[${completed.displayName} - ✓ completed]\n\n${completed.result || taskSummary(completed)}`,
            }],
            details: {
              agentId: completed.id,
              displayName: completed.displayName,
              status: completed.status,
              turns: completed.turns,
              usage: completed.usage,
              model: completed.model,
            },
          };
        }

        if (completed.status === "errored") {
          if (goal) goalEngine.appendProgress(agent.id, completed.error || "Unknown error", false);
          return {
            content: [{
              type: "text",
              text: `[${completed.displayName} - ✗ errored]\n\n**Error:** ${completed.error || "Unknown error"}`,
            }],
            isError: true,
            details: {
              agentId: completed.id,
              displayName: completed.displayName,
              status: completed.status,
              error: completed.error,
            },
          };
        }

        return {
          content: [{
            type: "text",
            text: `[${completed.displayName} - ☠ killed]\n\n${completed.error || "Killed"}`,
          }],
          isError: true,
        };
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

async function waitWithAbort(
  manager: AgentManager,
  agentId: string,
  signal: AbortSignal | undefined,
  onUpdate: any,
): Promise<import("../types").AgentState> {
  if (signal?.aborted) {
    manager.killAgent(agentId, "Aborted by orchestrator");
    return manager.waitForAgent(agentId);
  }

  let updateTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;
  const completion = manager.waitForAgent(agentId);
  const abort = new Promise<"aborted">((resolve) => {
    abortHandler = () => {
      manager.killAgent(agentId, "Aborted by orchestrator");
      resolve("aborted");
    };
    signal?.addEventListener("abort", abortHandler, { once: true });
    timeoutTimer = setTimeout(() => {
      manager.killAgent(agentId, "Timed out after 30 minutes");
      resolve("aborted");
    }, 30 * 60 * 1000);
  });

  if (onUpdate) {
    updateTimer = setInterval(() => {
      const current = manager.agents.get(agentId);
      if (!current) return;
      const elapsed = Math.round((Date.now() - current.startTime) / 1000);
      onUpdate({
        content: [{ type: "text", text: `⏳ ${current.displayName} working... (${elapsed}s, ${current.turns} turns)` }],
        details: { agentId, status: current.status, turns: current.turns },
      });
    }, 3000);
  }

  try {
    const result = await Promise.race([completion, abort]);
    if (result === "aborted") return completion;
    return result;
  } finally {
    if (updateTimer) clearInterval(updateTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
  }
}
