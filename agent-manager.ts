/**
 * Agent Manager - the heart of subdermial.
 *
 * Handles agent lifecycle: spawning, tracking, killing, and result collection.
 * Each agent runs as a separate `pi` process with its own session file.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickName } from "./name-generator";
import { serializeStore, CUSTOM_TYPE } from "./session-store";
import { info, warn, error, debug } from "./logger";
import type { AgentState, AgentStatus, AgentUsage, SubdermialConfig } from "./types";

const DEFAULT_CONFIG: SubdermialConfig = {
  maxConcurrency: 4,
  maxAgents: 20,
  sessionsDir: "",
  goalsDir: "",
  retryOnError: 0,
  defaultModel: "anthropic/claude-sonnet-4-5",
  defaultProfile: "worker",
};

export class AgentManager {
  private pi: ExtensionAPI;
  private ctx: ExtensionContext | null = null;
  private config: SubdermialConfig;
  agents: Map<string, AgentState> = new Map();
  usedNames: Set<string> = new Set();
  activeGoal: import("./types").GoalState | null = null;
  private onStateChange: (() => void) | null = null;
  private processes: Map<string, ChildProcess> = new Map();

  constructor(pi: ExtensionAPI, config?: Partial<SubdermialConfig>) {
    this.pi = pi;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Called when the extension has a UI context.
   */
  setContext(ctx: ExtensionContext): void {
    this.ctx = ctx;
  }

  /**
   * Set the callback invoked whenever agent state changes (for widget updates).
   */
  setOnStateChange(cb: () => void): void {
    this.onStateChange = cb;
  }

  /**
   * Set configuration overrides.
   */
  setConfig(overrides: Partial<SubdermialConfig>): void {
    this.config = { ...this.config, ...overrides };
  }

  /**
   * Get the full config.
   */
  getConfig(): SubdermialConfig {
    return { ...this.config };
  }

  /**
   * Spawn a new agent and return immediately. The agent runs asynchronously.
   * Results are delivered via callbacks.
   */
  async spawnAgent(params: {
    task: string;
    tools?: string[];
    model?: string;
    profile?: string;
    cwd?: string;
    systemPrompt?: string;
    goalId?: string;
  }): Promise<AgentState> {
    const { task, tools, model, profile, cwd, systemPrompt, goalId } = params;

    // Check agent limit
    const activeAgents = [...this.agents.values()].filter(
      (a) => a.status === "running" || a.status === "pending" || a.status === "open",
    );
    if (activeAgents.length >= this.config.maxAgents) {
      throw new Error(
        `Maximum agent limit reached (${this.config.maxAgents}). Wait for some agents to complete or kill them.`,
      );
    }

    // Generate unique name
    const name = pickName(this.usedNames);
    if (!name) {
      throw new Error("Name pool exhausted. Regenerate names or restart session.");
    }
    this.usedNames.add(name);

    // Create session file
    const sessionFile = path.join(this.config.sessionsDir, `${name}.jsonl`);
    fs.mkdirSync(this.config.sessionsDir, { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");

    // Determine tools
    const agentTools = tools && tools.length > 0 ? tools : ["read", "bash", "edit", "write", "grep", "find", "ls"];
    const agentModel = model || this.config.defaultModel;

    const agent: AgentState = {
      id: name,
      displayName: name,
      status: "pending",
      task,
      model: agentModel,
      tools: agentTools,
      sessionFile,
      startTime: Date.now(),
      turns: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      profile: profile || this.config.defaultProfile,
      goalId,
    };

    this.agents.set(name, agent);
    this.persist();
    this.notifyChange();

    // Start the agent asynchronously
    this.runAgentProcess(agent, systemPrompt, cwd).catch((err) => {
      error(`Agent ${name} process error`, err);
    });

    return agent;
  }

  /**
   * Kill an agent by ID.
   */
  killAgent(agentId: string, reason: string = "Killed by user"): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    // Kill the process if running
    const proc = this.processes.get(agentId);
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 3000);
    }

    agent.status = "killed";
    agent.error = reason;
    agent.endTime = Date.now();
    delete agent.pid;
    delete agent.terminalPid;
    this.processes.delete(agentId);
    this.persist();
    this.notifyChange();

    info(`Killed agent ${agentId}: ${reason}`);
    return true;
  }

  /**
   * Mark an agent as "open" (viewing in another terminal).
   */
  openAgent(agentId: string, terminalPid: number): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    agent.status = "open";
    agent.terminalPid = terminalPid;
    this.persist();
    this.notifyChange();

    // Start monitoring the terminal
    this.monitorTerminal(agentId, terminalPid);

    return true;
  }

  /**
   * Persist current state to the orchestrator session.
   */
  persist(): void {
    try {
      this.pi.appendEntry(CUSTOM_TYPE, serializeStore(this.agents, this.activeGoal, this.usedNames));
    } catch (err) {
      error("Failed to persist state", err);
    }
  }

  /**
   * Get a compacted summary of all agents (for display or context).
   */
  getAgentSummary(): string {
    const lines: string[] = [];
    for (const agent of this.agents.values()) {
      const icon = statusIcon(agent.status);
      const time = agent.endTime
        ? `${Math.round((agent.endTime - agent.startTime) / 1000)}s`
        : `${Math.round((Date.now() - agent.startTime) / 1000)}s`;
      lines.push(
        `${icon} ${agent.displayName} (${agent.profile || "agent"}) - ${agent.status} - ${time}` +
          (agent.error ? ` - ${agent.error}` : ""),
      );
    }
    return lines.join("\n");
  }

  private notifyChange(): void {
    if (this.onStateChange) this.onStateChange();
  }

  private async runAgentProcess(
    agent: AgentState,
    systemPrompt?: string,
    cwd?: string,
  ): Promise<void> {
    const args: string[] = ["--mode", "json", "-p", "--session", agent.sessionFile];

    if (agent.model) args.push("--model", agent.model);
    if (agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

    let tmpDir: string | null = null;
    let tmpPromptPath: string | null = null;

    try {
      if (systemPrompt) {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "subdermial-"));
        tmpPromptPath = path.join(tmpDir, "prompt.md");
        await fs.promises.writeFile(tmpPromptPath, systemPrompt, "utf-8");
        args.push("--system-prompt", tmpPromptPath);
      }

      // Task as the initial user prompt
      args.push(agent.task);

      agent.status = "running";
      agent.pid = 0; // placeholder, updated when process spawns
      this.notifyChange();

      debug(`Spawning agent ${agent.id}: pi ${args.join(" ")}`);

      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? this.ctx?.cwd ?? process.cwd(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      agent.pid = proc.pid ?? 0;
      this.processes.set(agent.id, proc);
      this.notifyChange();

      let buffer = "";
      let exitResolve: ((code: number) => void) | null = null;
      const exitPromise = new Promise<number>((resolve) => {
        exitResolve = resolve;
      });

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message;
          if (msg.role === "assistant") {
            agent.turns++;
            const usage = msg.usage;
            if (usage) {
              agent.usage.input += usage.input || 0;
              agent.usage.output += usage.output || 0;
              agent.usage.cacheRead += usage.cacheRead || 0;
              agent.usage.cacheWrite += usage.cacheWrite || 0;
              agent.usage.cost += usage.cost?.total || 0;
              agent.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!agent.model && msg.model) agent.model = msg.model;
          }
          this.notifyChange();
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      let stderr = "";
      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        this.processes.delete(agent.id);
        exitResolve!(code ?? 0);
      });

      proc.on("error", (err) => {
        error(`Agent ${agent.id} spawn error`, err);
        this.processes.delete(agent.id);
        exitResolve!(1);
      });

      const exitCode = await exitPromise;

      // Determine result
      if (exitCode === 0 && agent.turns > 0) {
        agent.status = "completed";
        agent.result = `Agent ${agent.id} completed: ${agent.task}\nTurns: ${agent.turns}, Cost: $${agent.usage.cost.toFixed(4)}`;
      } else if (exitCode !== 0) {
        agent.status = "errored";
        agent.error = stderr.trim() || `Exit code ${exitCode}`;
        agent.result = `Agent ${agent.id} failed: ${agent.error}`;
      } else {
        agent.status = "completed";
        agent.result = `Agent ${agent.id} completed (no turns recorded)`;
      }

      agent.endTime = Date.now();
      delete agent.pid;
      this.persist();
      this.notifyChange();

      info(
        `Agent ${agent.id} ${agent.status}: ${agent.turns} turns, $${agent.usage.cost.toFixed(4)}`,
      );

      // Inject result as message to orchestrator
      try {
        this.pi.sendMessage(
          {
            customType: "subdermial-agent-result",
            content: `[Agent ${agent.id} (${agent.profile || "agent"}) - ${agent.status}]\n\n**Task:** ${agent.task}\n\n**Result:** ${agent.result}\n\n**Usage:** ${agent.turns} turns, ↑${formatTokens(agent.usage.input)} ↓${formatTokens(agent.usage.output)} $${agent.usage.cost.toFixed(4)}`,
            display: true,
          },
          { triggerTurn: agent.status === "errored" ? true : false },
        );
      } catch {
        // Non-critical if message injection fails
      }
    } catch (err: any) {
      error(`Agent ${agent.id} fatal error`, err);
      agent.status = "errored";
      agent.error = err.message || String(err);
      agent.endTime = Date.now();
      delete agent.pid;
      this.processes.delete(agent.id);
      this.persist();
      this.notifyChange();
    } finally {
      // Cleanup temp files
      if (tmpPromptPath) {
        try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
      }
      if (tmpDir) {
        try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Monitor a terminal process and mark agent as dead when terminal closes.
   */
  private monitorTerminal(agentId: string, pid: number): void {
    const check = () => {
      try {
        // Check if process still exists
        process.kill(pid, 0);
        // Still alive, check again later
        setTimeout(check, 5000);
      } catch {
        // Process gone, mark agent as dead
        const agent = this.agents.get(agentId);
        if (agent && agent.status === "open") {
          agent.status = agent.error ? "errored" : "completed"; // Keep previous completion status
          agent.endTime = Date.now();
          delete agent.terminalPid;
          this.persist();
          this.notifyChange();
          info(`Agent ${agentId} terminal closed, marked as dead`);
        }
      }
    };
    setTimeout(check, 5000);
  }
}

/**
 * Get the pi invocation (command + args) for spawning a subprocess.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

/**
 * Return a unicode icon for an agent status.
 */
export function statusIcon(status: AgentStatus): string {
  switch (status) {
    case "pending": return "⏺";
    case "running": return "⏳";
    case "completed": return "✓";
    case "errored": return "✗";
    case "killed": return "☠";
    case "open": return "◉";
    case "dead": return "☠";
  }
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}
