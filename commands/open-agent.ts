/**
 * /open-agent command - reopen an agent's session in a new terminal.
 *
 * Shows a scrollable list of all agents from this session,
 * then opens the selected agent's session file in a new pi instance.
 */

import { spawn } from "node:child_process";
import * as os from "node:os";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager";
import { statusIcon } from "../agent-manager";
import { info, error } from "../logger";

/**
 * Detect the available terminal emulator.
 */
function detectTerminal(): string | null {
  const candidates = [
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "alacritty",
    "kitty",
    "wezterm",
    "terminator",
    "tilix",
    "urxvt",
    "rxvt",
    "xterm",
    "foot",
    "st",
  ];

  // Check if we're on macOS
  if (os.platform() === "darwin") {
    return "osascript"; // Will use AppleScript
  }

  // Check common terminal env vars
  const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
  const term = process.env.TERM || "";

  if (termProgram.includes("alacritty")) return "alacritty";
  if (termProgram.includes("kitty")) return "kitty";
  if (termProgram.includes("wezterm")) return "wezterm";

  return candidates[0]; // Default: try gnome-terminal
}

/**
 * Build the command to open a terminal with pi.
 */
function buildOpenCommand(terminal: string, sessionFile: string): { command: string; args: string[] } {
  if (terminal === "osascript") {
    // macOS: use osascript to open Terminal.app
    const script = `tell app "Terminal" to do script "pi --session '${sessionFile}'"`;
    return { command: "osascript", args: ["-e", script] };
  }

  switch (terminal) {
    case "gnome-terminal":
      return {
        command: "gnome-terminal",
        args: ["--", "pi", "--session", sessionFile],
      };
    case "konsole":
      return {
        command: "konsole",
        args: ["-e", "pi", "--session", sessionFile],
      };
    case "xfce4-terminal":
      return {
        command: "xfce4-terminal",
        args: ["-e", `pi --session "${sessionFile}"`],
      };
    case "alacritty":
      return {
        command: "alacritty",
        args: ["-e", "pi", "--session", sessionFile],
      };
    case "kitty":
      return {
        command: "kitty",
        args: ["pi", "--session", sessionFile],
      };
    case "wezterm":
      return {
        command: "wezterm",
        args: ["start", "--", "pi", "--session", sessionFile],
      };
    case "xterm":
      return {
        command: "xterm",
        args: ["-e", `pi --session "${sessionFile}"`],
      };
    default:
      // Best-effort fallback: try gnome-terminal pattern
      return {
        command: terminal,
        args: ["-e", `pi --session "${sessionFile}"`],
      };
  }
}

export function createOpenAgentCommand(manager: AgentManager) {
  return {
    description: "Open a subdermial agent's session in a new terminal",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const agents = [...manager.agents.values()];

      if (agents.length === 0) {
        ctx.ui.notify("No agents have been spawned in this session", "info");
        return;
      }

      // Filter to agents that have session files
      const validAgents = agents.filter((a) => a.sessionFile);
      if (validAgents.length === 0) {
        ctx.ui.notify("No agents with session files found", "info");
        return;
      }

      // Build the selection list
      const choices: string[] = validAgents.map((a) => {
        const icon = statusIcon(a.status);
        const elapsed = a.endTime
          ? `${Math.round((a.endTime - a.startTime) / 1000)}s`
          : `${Math.round((Date.now() - a.startTime) / 1000)}s`;
        const taskPreview = a.task.length > 50 ? a.task.slice(0, 50) + "..." : a.task;
        return `${icon} ${a.displayName} (${a.profile || "agent"}) [${a.status}] ${elapsed} - ${taskPreview}`;
      });

      const choice = await ctx.ui.select("Open agent session:", choices);
      if (!choice) return;

      // Extract agent ID from the choice string
      const agentId = extractAgentId(choice, validAgents);
      if (!agentId) {
        ctx.ui.notify("Could not identify selected agent", "error");
        return;
      }

      const agent = manager.agents.get(agentId);
      if (!agent || !agent.sessionFile) {
        ctx.ui.notify("Agent session file not found", "error");
        return;
      }

      const terminal = detectTerminal();
      if (!terminal) {
        ctx.ui.notify("No terminal emulator detected", "error");
        return;
      }

      try {
        const cmd = buildOpenCommand(terminal, agent.sessionFile);
        info(`Opening terminal: ${cmd.command} ${cmd.args.join(" ")}`);

        const proc = spawn(cmd.command, cmd.args, {
          detached: true,
          stdio: "ignore",
          shell: false,
        });

        proc.unref();

        if (proc.pid) {
          manager.openAgent(agentId, proc.pid);
          ctx.ui.notify(
            `Opened ${agent.displayName} in new terminal (pid: ${proc.pid})`,
            "info",
          );
        } else {
          manager.openAgent(agentId, 0);
          ctx.ui.notify(`Opened ${agent.displayName} in new terminal`, "info");
        }
      } catch (err: any) {
        error(`Failed to open terminal for ${agentId}`, err);
        ctx.ui.notify(`Failed to open terminal: ${err.message}`, "error");

        // Still mark as open attempt
        manager.openAgent(agentId, 0);
      }
    },
  };
}

/**
 * Extract the agent ID from the selection string.
 * The format is: "icon name (profile) [status] time - task"
 */
function extractAgentId(choice: string, agents: import("../types").AgentState[]): string | null {
  // Try to match by display name
  for (const agent of agents) {
    if (choice.includes(agent.displayName)) {
      return agent.id;
    }
  }
  return null;
}
