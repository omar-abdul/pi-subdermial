/**
 * /agent command - quickly spawn a single subagent.
 *
 * Usage:
 *   /agent "find all auth code" --tools read,grep,find --model haiku
 *   /agent "implement caching" --profile worker
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager";
import { info, error } from "../logger";

interface ParsedArgs {
  task: string;
  tools?: string;
  model?: string;
  profile?: string;
  cwd?: string;
}

function parseArgs(rawArgs: string): ParsedArgs | { error: string } {
  // Match quoted string or unquoted first arg as task
  let task = "";
  const rest: string[] = [];

  const trimmed = rawArgs.trim();
  if (trimmed.startsWith('"')) {
    const endIdx = trimmed.indexOf('"', 1);
    if (endIdx === -1) return { error: "Unclosed quote in task" };
    task = trimmed.slice(1, endIdx);
    const remainder = trimmed.slice(endIdx + 1).trim();
    if (remainder) rest.push(...remainder.split(/\s+/));
  } else if (trimmed.startsWith("'")) {
    const endIdx = trimmed.indexOf("'", 1);
    if (endIdx === -1) return { error: "Unclosed quote in task" };
    task = trimmed.slice(1, endIdx);
    const remainder = trimmed.slice(endIdx + 1).trim();
    if (remainder) rest.push(...remainder.split(/\s+/));
  } else {
    // Try to find -- to split task from flags
    const flagIdx = trimmed.indexOf(" --");
    if (flagIdx === -1) {
      task = trimmed;
    } else {
      task = trimmed.slice(0, flagIdx).trim();
      const flagPart = trimmed.slice(flagIdx + 1).trim();
      // Parse flags manually
      rest.push(...flagPart.split(/\s+(?=--)/));
    }
  }

  const result: ParsedArgs = { task };

  // Parse flags
  let currentFlag: string | null = null;
  for (const token of rest) {
    if (token.startsWith("--")) {
      if (token.includes("=")) {
        const [flag, value] = token.split("=", 2);
        const flagName = flag.slice(2);
        setFlag(result, flagName, value);
        currentFlag = null;
      } else {
        const flagName = token.slice(2);
        // Boolean flags
        if (flagName === "help") {
          return { error: "help" };
        }
        currentFlag = flagName;
      }
    } else if (currentFlag) {
      setFlag(result, currentFlag, token);
      currentFlag = null;
    }
  }

  if (!result.task) return { error: "No task specified" };
  return result;
}

function setFlag(result: ParsedArgs, flag: string, value: string): void {
  switch (flag) {
    case "tools":
    case "t":
      result.tools = value;
      break;
    case "model":
    case "m":
      result.model = value;
      break;
    case "profile":
    case "p":
      result.profile = value;
      break;
    case "cwd":
      result.cwd = value;
      break;
  }
}

export function createAgentCommand(manager: AgentManager) {
  return {
    description: "Spawn a subdermial agent for a specific task",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parsed = parseArgs(args);

      if (typeof parsed === "object" && "error" in parsed) {
        if (parsed.error === "help") {
          ctx.ui.notify(
            "Usage: /agent \"task\" [--tools read,edit] [--model haiku] [--profile scout]",
            "info",
          );
          return;
        }
        ctx.ui.notify(`Error: ${parsed.error}`, "error");
        return;
      }

      const { task, tools, model, profile, cwd } = parsed as ParsedArgs;

      // Resolve API key for the agent's model
      let apiKey: string | undefined;
      try {
        const agentModel = model || manager.getConfig().defaultModel;
        const [provider, modelId] = agentModel.includes("/") ? agentModel.split("/", 2) : ["anthropic", agentModel];
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

      ctx.ui.notify(`Spawning agent for: ${task.slice(0, 60)}...`, "info");

      try {
        const agent = await manager.spawnAgent({
          task,
          tools: tools ? tools.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
          model,
          profile,
          cwd: cwd || ctx.cwd,
          apiKey,
        });

        ctx.ui.notify(
          `Agent ${agent.displayName} spawned (${agent.profile || "agent"})`,
          "info",
        );

        info(
          `/agent spawned ${agent.displayName}: ${task.slice(0, 80)}`,
        );
      } catch (err: any) {
        error("/agent failed", err);
        ctx.ui.notify(`Failed to spawn agent: ${err.message}`, "error");
      }
    },
  };
}
