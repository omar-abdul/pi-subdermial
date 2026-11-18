/**
 * /agent command - quickly spawn a single subagent.
 *
 * Usage:
 *   /agent "find all auth code" --tools read,grep,find --model haiku
 *   /agent "implement caching" --profile worker
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { normalizeTask, type AgentManager } from "../agent-manager";
import { info, error } from "../logger";

interface ParsedArgs {
  task: string;
  tools?: string;
  model?: string;
  profile?: string;
  cwd?: string;
}

function parseArgs(rawArgs: string): ParsedArgs | { error: string } {
  const tokenized = tokenize(rawArgs);
  if ("error" in tokenized) return tokenized;

  const result: ParsedArgs = { task: "" };
  const taskParts: string[] = [];
  const tokens = tokenized.tokens;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      taskParts.push(...tokens.slice(i + 1));
      break;
    }

    if (!token.startsWith("--")) {
      taskParts.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const flag = (equalsIndex === -1 ? token.slice(2) : token.slice(2, equalsIndex)).trim();
    if (flag === "help") return { error: "help" };
    if (!isSupportedFlag(flag)) return { error: `Unknown option: --${flag}` };

    let value: string | undefined = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
    if (value === undefined) {
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: `Option --${flag} requires a value` };
      }
      value = next;
      i++;
    }
    setFlag(result, flag, value);
  }

  result.task = normalizeTask(taskParts.join(" "));
  if (!result.task) return { error: "No task specified" };
  return result;
}

function tokenize(input: string): { tokens: string[] } | { error: string } {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }

  if (escaped) current += "\\";
  if (quote) return { error: "Unclosed quote" };
  if (current) tokens.push(current);
  return { tokens };
}

function isSupportedFlag(flag: string): boolean {
  return flag === "tools" || flag === "t" || flag === "model" || flag === "m" ||
    flag === "profile" || flag === "p" || flag === "cwd";
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

function clearCommandInput(ctx: ExtensionCommandContext): void {
  if (ctx.hasUI) ctx.ui.setEditorText("");
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
        clearCommandInput(ctx);
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
        clearCommandInput(ctx);
        ctx.ui.notify(`Failed to spawn agent: ${err.message}`, "error");
      }
    },
  };
}
