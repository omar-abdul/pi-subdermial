/**
 * /open-agent command - reopen an agent's session in a new terminal.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager";
import { statusIcon } from "../agent-manager";
import { info, error } from "../logger";

type OpenCommand = {
  command: string;
  args: string[];
  monitor: boolean;
};

function commandAvailable(command: string): boolean {
  if (os.platform() === "win32") return false;
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

/** Detect a usable terminal emulator. */
function detectTerminal(): string | null {
  if (os.platform() === "darwin") return "osascript";

  const requested = process.env.SUBDERMIAL_TERMINAL?.toLowerCase();
  if (requested === "tmux" && commandAvailable("tmux")) return "tmux";
  if (requested && commandAvailable(requested)) return requested;

  // Prefer a tmux window when explicitly requested or when the extension is
  // already running inside tmux. The tmux client exits after creating the
  // window, so it is deliberately treated as unmonitored.
  if ((requested === "tmux" || process.env.TMUX) && commandAvailable("tmux")) return "tmux";

  const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
  const preferred = termProgram.includes("alacritty") ? "alacritty"
    : termProgram.includes("kitty") ? "kitty"
      : termProgram.includes("wezterm") ? "wezterm" : null;
  if (preferred && commandAvailable(preferred)) return preferred;

  const candidates = [
    "gnome-terminal", "konsole", "xfce4-terminal", "alacritty", "kitty",
    "wezterm", "terminator", "tilix", "urxvt", "rxvt", "xterm", "foot", "st",
  ];
  return candidates.find(commandAvailable) || null;
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteForAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildOpenCommand(terminal: string, sessionFile: string, agentId: string): OpenCommand {
  if (terminal === "osascript") {
    const command = `pi --session ${quoteForShell(sessionFile)}`;
    const script = `tell app "Terminal" to do script "${quoteForAppleScript(command)}"`;
    return { command: "osascript", args: ["-e", script], monitor: false };
  }

  if (terminal === "tmux") {
    return {
      command: "tmux",
      args: ["new-window", "-n", `subdermial-${agentId}`, "--", "pi", "--session", sessionFile],
      monitor: false,
    };
  }

  switch (terminal) {
    case "gnome-terminal":
      return { command: terminal, args: ["--", "pi", "--session", sessionFile], monitor: false };
    case "konsole":
      return { command: terminal, args: ["-e", "pi", "--session", sessionFile], monitor: false };
    case "xfce4-terminal":
      return { command: terminal, args: ["-e", `pi --session ${quoteForShell(sessionFile)}`], monitor: false };
    case "alacritty":
      return { command: terminal, args: ["-e", "pi", "--session", sessionFile], monitor: false };
    case "kitty":
      return { command: terminal, args: ["pi", "--session", sessionFile], monitor: false };
    case "wezterm":
      return { command: terminal, args: ["start", "--", "pi", "--session", sessionFile], monitor: false };
    case "xterm":
      return { command: terminal, args: ["-e", `pi --session ${quoteForShell(sessionFile)}`], monitor: false };
    default:
      return { command: terminal, args: ["-e", "pi", "--session", sessionFile], monitor: false };
  }
}

function launchDetached(command: OpenCommand): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const waitForExit = command.command === "tmux" || command.command === "osascript";
    const proc = spawn(command.command, command.args, {
      detached: true,
      stdio: waitForExit ? ["ignore", "ignore", "pipe"] : "ignore",
      shell: false,
    });
    let launcherStderr = "";
    if (waitForExit && proc.stderr) {
      proc.stderr.on("data", (data: Buffer) => {
        launcherStderr += data.toString().slice(0, 8192 - launcherStderr.length);
      });
    }

    proc.once("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    proc.once("spawn", () => {
      if (settled) return;
      if (command.command === "tmux" || command.command === "osascript") {
        // These are launcher commands, so a successful spawn is not enough:
        // tmux can still fail because there is no server/session, and osascript
        // can reject the AppleScript. Wait for their real exit status.
        proc.once("close", (code) => {
          if (code === 0) {
            settled = true;
            resolve(proc);
          } else {
            settled = true;
            const detail = launcherStderr
              .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "")
              .replace(/[\u0000-\u001F\u007F]/g, " ")
              .trim();
            reject(new Error(`${command.command} exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`));
          }
        });
        return;
      }
      settled = true;
      proc.unref();
      resolve(proc);
    });
  });
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

      const validAgents = agents.filter((a) => a.sessionFile);
      if (validAgents.length === 0) {
        ctx.ui.notify("No agents with session files found", "error");
        return;
      }

      const choices = validAgents.map((a) => {
        const icon = statusIcon(a.status);
        const elapsed = a.endTime
          ? `${Math.round((a.endTime - a.startTime) / 1000)}s`
          : `${Math.round((Date.now() - a.startTime) / 1000)}s`;
        const taskPreview = a.task.length > 50 ? a.task.slice(0, 50) + "..." : a.task;
        return `${icon} ${a.displayName} (${a.profile || "agent"}) [${a.status}] ${elapsed} - ${taskPreview}`;
      });

      const choice = await ctx.ui.select("Open agent session:", choices);
      if (!choice) return;

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
      if (agent.status === "running" || agent.status === "pending") {
        ctx.ui.notify("Cannot open an agent while its background process is running", "warning");
        return;
      }

      const terminal = detectTerminal();
      if (!terminal) {
        ctx.ui.notify("No usable terminal emulator detected", "error");
        return;
      }

      const cmd = buildOpenCommand(terminal, agent.sessionFile, agentId);
      try {
        info(`Opening terminal: ${cmd.command} ${cmd.args.join(" ")}`);
        const proc = await launchDetached(cmd);
        const opened = manager.openAgent(agentId, cmd.monitor ? proc.pid : undefined, cmd.monitor);
        if (!opened) {
          ctx.ui.notify("Agent state changed before the terminal opened", "warning");
          return;
        }
        ctx.ui.notify(
          cmd.monitor && proc.pid
            ? `Opened ${agent.displayName} in a new terminal (pid: ${proc.pid})`
            : `Opened ${agent.displayName} in a new ${terminal} window`,
          "info",
        );
      } catch (err: any) {
        error(`Failed to open terminal for ${agentId}`, err);
        clearCommandInput(ctx);
        const message = err?.message || String(err);
        ctx.ui.notify(`Failed to open terminal: ${message}`, "error");
        // Crucially, do not mark the agent open after a failed launch.
      }
    },
  };
}

function clearCommandInput(ctx: ExtensionCommandContext): void {
  if (ctx.hasUI) ctx.ui.setEditorText("");
}

function extractAgentId(choice: string, agents: import("../types").AgentState[]): string | null {
  for (const agent of agents) {
    if (choice.includes(agent.displayName)) return agent.id;
  }
  return null;
}
