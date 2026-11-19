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
import { info, error, debug } from "./logger";
import type { AgentState, AgentStatus, SubdermialConfig } from "./types";

const DEFAULT_CONFIG: SubdermialConfig = {
  maxConcurrency: 4,
  maxAgents: 20,
  sessionsDir: "",
  goalsDir: "",
  retryOnError: 0,
  // Empty by default: the active Pi model/provider is resolved at spawn time.
  defaultModel: "",
  defaultProvider: "",
  defaultProfile: "worker",
};

const MAX_STDERR_LENGTH = 32 * 1024;
const MAX_RESULT_LENGTH = 64 * 1024;
const KILL_GRACE_PERIOD_MS = 3000;

type ExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;
};

interface AgentRun {
  completion: Promise<AgentState>;
  resolve: (agent: AgentState) => void;
  process?: ChildProcess;
  cancelled: boolean;
  finalized: boolean;
  exited: boolean;
  killTimer?: NodeJS.Timeout;
  spawnError?: Error;
  eventError?: string;
  latestAssistantText?: string;
}

export function normalizeTask(input: string): string {
  return input.replace(/\r\n?/g, "\n").replace(/\0/g, "").trim();
}

function sanitizeDiagnostic(input: string): string {
  return input
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, MAX_STDERR_LENGTH);
}

function boundedAppend(current: string, next: string, max: number): string {
  if (current.length >= max) return current;
  const remaining = max - current.length;
  return current + next.slice(0, remaining);
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

export class AgentManager {
  private pi: ExtensionAPI;
  private ctx: ExtensionContext | null = null;
  private config: SubdermialConfig;
  agents: Map<string, AgentState> = new Map();
  usedNames: Set<string> = new Set();
  activeGoal: import("./types").GoalState | null = null;
  private onStateChange: (() => void) | null = null;
  private runs: Map<string, AgentRun> = new Map();
  private terminalMonitors: Map<string, NodeJS.Timeout> = new Map();
  private shuttingDown = false;

  constructor(pi: ExtensionAPI, config?: Partial<SubdermialConfig>) {
    this.pi = pi;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setContext(ctx: ExtensionContext): void {
    this.ctx = ctx;
  }

  setOnStateChange(cb: () => void): void {
    this.onStateChange = cb;
  }

  setConfig(overrides: Partial<SubdermialConfig>): void {
    this.config = { ...this.config, ...overrides };
  }

  getConfig(): SubdermialConfig {
    return { ...this.config };
  }

  /** Spawn a new agent and return immediately. The agent runs asynchronously. */
  async spawnAgent(params: {
    task: string;
    tools?: string[];
    model?: string;
    profile?: string;
    cwd?: string;
    systemPrompt?: string;
    goalId?: string;
    /** Provider for model. Resolved dynamically when omitted. */
    provider?: string;
    apiKey?: string;
    notifyOrchestrator?: boolean;
  }): Promise<AgentState> {
    if (this.shuttingDown) throw new Error("Subdermial is shutting down");

    const task = normalizeTask(params.task);
    if (!task) throw new Error("Task cannot be empty");

    const activeAgents = [...this.agents.values()].filter(
      (a) => a.status === "running" || a.status === "pending",
    );
    if (activeAgents.length >= this.config.maxConcurrency) {
      throw new Error(
        `Maximum concurrent agent limit reached (${this.config.maxConcurrency}). Wait for an agent to finish or kill one.`,
      );
    }
    if (this.agents.size >= this.config.maxAgents) {
      throw new Error(
        `Maximum agent limit reached (${this.config.maxAgents}). Wait for some agents to complete or kill them.`,
      );
    }

    const name = pickName(this.usedNames);
    if (!name) throw new Error("Name pool exhausted. Regenerate names or restart session.");
    this.usedNames.add(name);

    const sessionFile = path.join(this.config.sessionsDir, `${name}.jsonl`);
    fs.mkdirSync(this.config.sessionsDir, { recursive: true });
    fs.writeFileSync(sessionFile, "", "utf-8");

    const agentTools = params.tools && params.tools.length > 0
      ? params.tools
      : ["read", "bash", "edit", "write", "grep", "find", "ls"];
    const resolvedModel = splitModelReference(
      params.provider || this.config.defaultProvider || this.ctx?.model?.provider,
      params.model || this.config.defaultModel || this.ctx?.model?.id,
    );
    if (!resolvedModel.model) {
      throw new Error(
        "No model was selected for the subagent. Select a model in Pi or pass an explicit model.",
      );
    }
    if (!resolvedModel.provider) {
      throw new Error(
        `No provider was selected for model "${resolvedModel.model}". Select a model in Pi or pass provider/model.`,
      );
    }
    const agent: AgentState = {
      id: name,
      displayName: name,
      status: "pending",
      task,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      tools: agentTools,
      sessionFile,
      startTime: Date.now(),
      turns: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      profile: params.profile || this.config.defaultProfile,
      goalId: params.goalId,
    };

    let resolve!: (state: AgentState) => void;
    const completion = new Promise<AgentState>((done) => { resolve = done; });
    const run: AgentRun = {
      completion,
      resolve,
      cancelled: false,
      finalized: false,
      exited: false,
    };

    this.agents.set(name, agent);
    this.runs.set(name, run);
    this.persist();
    this.notifyChange();

    this.runAgentProcess(agent, run, params.systemPrompt, params.cwd, params.apiKey, params.notifyOrchestrator !== false)
      .catch((err) => {
        error(`Agent ${name} process error`, err);
        this.finalizeRun(agent, run, {
          code: 1,
          signal: null,
          spawnError: err instanceof Error ? err : new Error(String(err)),
        }, "");
      });

    return agent;
  }

  /** Wait for a manager-owned run to reach one terminal state. */
  async waitForAgent(agentId: string): Promise<AgentState> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);
    const run = this.runs.get(agentId);
    if (run) return run.completion;
    return agent;
  }

  /** Kill an agent without allowing its late close event to resurrect it. */
  killAgent(agentId: string, reason: string = "Killed by user"): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (agent.status === "completed" || agent.status === "errored" || agent.status === "killed" || agent.status === "dead") {
      return false;
    }

    const run = this.runs.get(agentId);
    if (run && !run.finalized) {
      run.cancelled = true;
      agent.status = "killed";
      agent.error = sanitizeDiagnostic(reason);
      agent.endTime = Date.now();

      const proc = run.process;
      if (proc && !run.exited) {
        try { proc.kill("SIGTERM"); } catch { /* already exited */ }
        run.killTimer = setTimeout(() => {
          if (!run.exited && !run.finalized) {
            try { proc.kill("SIGKILL"); } catch { /* already exited */ }
          }
        }, KILL_GRACE_PERIOD_MS);
      }
    } else {
      agent.status = "killed";
      agent.error = sanitizeDiagnostic(reason);
      agent.endTime = Date.now();
      delete agent.pid;
    }

    delete agent.terminalPid;
    agent.terminalStatus = "closed";
    this.clearTerminalMonitor(agentId);
    this.persist();
    this.notifyChange();
    info(`Killed agent ${agentId}: ${reason}`);
    return true;
  }

  /** Mark a successfully launched interactive terminal as open. */
  openAgent(agentId: string, terminalPid?: number, monitor = true): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (agent.status === "running" || agent.status === "pending") return false;

    this.clearTerminalMonitor(agentId);
    agent.status = "open";
    agent.terminalPid = terminalPid;
    agent.terminalStatus = monitor && terminalPid && terminalPid > 0 ? "open" : "unmonitored";
    this.persist();
    this.notifyChange();

    if (agent.terminalStatus === "open") this.monitorTerminal(agentId, terminalPid!);
    return true;
  }

  persist(): void {
    try {
      this.pi.appendEntry(CUSTOM_TYPE, serializeStore(this.agents, this.activeGoal, this.usedNames));
    } catch (err) {
      error("Failed to persist state", err);
    }
  }

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

  /** Stop managed children and monitoring timers during session shutdown. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const agent of [...this.agents.values()]) {
      if (agent.status === "pending" || agent.status === "running") {
        this.killAgent(agent.id, "Orchestrator shutting down");
      }
    }
    this.terminalMonitors.forEach((timer) => clearTimeout(timer));
    this.terminalMonitors.clear();

    const pending = [...this.runs.values()].map((run) => run.completion);
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_PERIOD_MS + 500)),
    ]);
  }

  private notifyChange(): void {
    if (this.onStateChange) this.onStateChange();
  }

  private async runAgentProcess(
    agent: AgentState,
    run: AgentRun,
    systemPrompt?: string,
    cwd?: string,
    apiKey?: string,
    notifyOrchestrator = true,
  ): Promise<void> {
    const args: string[] = ["--mode", "json", "-p", "--session", agent.sessionFile];
    if (agent.model) args.push("--model", agent.model);
    if (agent.provider) args.push("--provider", agent.provider);
    if (agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

    let env = process.env;
    if (apiKey) {
      args.push("--api-key", apiKey);
    } else {
      env = { ...process.env };
    }

    let tmpDir: string | null = null;
    let tmpPromptPath: string | null = null;
    let stderr = "";

    try {
      if (systemPrompt) {
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "subdermial-"));
        tmpPromptPath = path.join(tmpDir, "prompt.md");
        await fs.promises.writeFile(tmpPromptPath, systemPrompt, "utf-8");
        args.push("--system-prompt", tmpPromptPath);
      }

      if (run.cancelled || agent.status === "killed") {
        this.finalizeRun(agent, run, { code: null, signal: "SIGTERM" }, "");
        return;
      }

      // `--` keeps a task beginning with a dash from being parsed as a Pi option.
      args.push("--", agent.task);
      const invocation = getPiInvocation(args);
      const displayArgs = args.map((arg, index) => args[index - 1] === "--api-key" ? "<redacted>" : arg);
      debug(`Spawning agent ${agent.id}: ${invocation.command} ${displayArgs.join(" ")}`);

      const proc = spawn(invocation.command, invocation.args, {
        cwd: cwd ?? this.ctx?.cwd ?? process.cwd(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      run.process = proc;
      agent.status = "running";
      agent.pid = proc.pid;
      this.persist();
      this.notifyChange();

      if (run.cancelled || agent.status === "killed") {
        try { proc.kill("SIGTERM"); } catch { /* already exited */ }
      }

      let buffer = "";
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
            if (msg.stopReason || msg.stop_reason) agent.stopReason = msg.stopReason || msg.stop_reason;
            const text = messageText(msg.content);
            if (text) run.latestAssistantText = boundedAppend("", text, MAX_RESULT_LENGTH);
            if (msg.stopReason === "error" || msg.stop_reason === "error") {
              run.eventError = text || "The agent reported an error";
            }
          }
        } else if (event.type === "error" || event.error) {
          const detail = typeof event.error === "string" ? event.error : event.error?.message;
          if (detail) run.eventError = sanitizeDiagnostic(detail);
        }
        this.notifyChange();
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data: Buffer) => {
        stderr = boundedAppend(stderr, data.toString(), MAX_STDERR_LENGTH);
      });

      const exitInfo = await new Promise<ExitInfo>((resolve) => {
        let settled = false;
        const finish = (info: ExitInfo) => {
          if (settled) return;
          settled = true;
          run.exited = true;
          resolve(info);
        };
        proc.once("error", (err) => {
          run.spawnError = err;
          finish({ code: null, signal: null, spawnError: err });
        });
        proc.once("close", (code, signal) => {
          if (buffer.trim()) processLine(buffer);
          finish({ code, signal });
        });
      });

      this.finalizeRun(agent, run, exitInfo, stderr, notifyOrchestrator);
    } catch (err) {
      this.finalizeRun(
        agent,
        run,
        { code: 1, signal: null, spawnError: err instanceof Error ? err : new Error(String(err)) },
        stderr,
        notifyOrchestrator,
      );
    } finally {
      if (tmpPromptPath) {
        try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
      }
      if (tmpDir) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  }

  private finalizeRun(
    agent: AgentState,
    run: AgentRun,
    exitInfo: ExitInfo,
    stderr: string,
    notifyOrchestrator = true,
  ): void {
    if (run.finalized) return;
    run.finalized = true;
    run.exited = true;
    if (run.killTimer) clearTimeout(run.killTimer);

    const cancelled = run.cancelled || agent.status === "killed";
    const diagnostic = sanitizeDiagnostic(
      run.eventError || exitInfo.spawnError?.message || stderr ||
      (exitInfo.signal ? `Process terminated by ${exitInfo.signal}` : ""),
    );

    if (cancelled) {
      agent.status = "killed";
      agent.error = agent.error || "Killed";
      agent.result = `Agent ${agent.id} was killed: ${agent.error}`;
    } else if (exitInfo.spawnError || exitInfo.code === null || exitInfo.signal || exitInfo.code !== 0 || run.eventError) {
      agent.status = "errored";
      agent.error = diagnostic || `Exit code ${exitInfo.code ?? "unknown"}`;
      agent.result = `Agent ${agent.id} failed: ${agent.error}`;
    } else {
      agent.status = "completed";
      const response = sanitizeDiagnostic(run.latestAssistantText || "");
      agent.result = response || `Agent ${agent.id} completed (no response recorded)`;
    }

    agent.endTime = agent.endTime || Date.now();
    delete agent.pid;
    run.process = undefined;
    if (this.runs.get(agent.id) === run) this.runs.delete(agent.id);
    this.persist();
    this.notifyChange();
    run.resolve(agent);

    info(`Agent ${agent.id} ${agent.status}: ${agent.turns} turns, $${agent.usage.cost.toFixed(4)}`);

    if (notifyOrchestrator && !this.shuttingDown) {
      try {
        this.pi.sendMessage(
          {
            customType: "subdermial-agent-result",
            content: `[Agent ${agent.id} (${agent.profile || "agent"}) - ${agent.status}]\n\n**Task:** ${agent.task}\n\n**Result:** ${agent.result}\n\n**Usage:** ${agent.turns} turns, ↑${formatTokens(agent.usage.input)} ↓${formatTokens(agent.usage.output)} $${agent.usage.cost.toFixed(4)}`,
            display: true,
          },
          { triggerTurn: agent.status === "errored" },
        );
      } catch {
        // Non-critical if message injection fails.
      }
    }
  }

  private monitorTerminal(agentId: string, pid: number): void {
    const check = () => {
      try {
        process.kill(pid, 0);
        const timer = setTimeout(check, 5000);
        this.terminalMonitors.set(agentId, timer);
      } catch {
        const agent = this.agents.get(agentId);
        this.terminalMonitors.delete(agentId);
        if (agent && agent.status === "open") {
          agent.status = "dead";
          agent.terminalStatus = "closed";
          delete agent.terminalPid;
          this.persist();
          this.notifyChange();
          info(`Agent ${agentId} terminal closed`);
        }
      }
    };
    const timer = setTimeout(check, 5000);
    this.terminalMonitors.set(agentId, timer);
  }

  private clearTerminalMonitor(agentId: string): void {
    const timer = this.terminalMonitors.get(agentId);
    if (timer) clearTimeout(timer);
    this.terminalMonitors.delete(agentId);
  }
}

function splitModelReference(
  provider: string | undefined,
  model: string | undefined,
): { provider?: string; model?: string } {
  if (!model?.trim()) return {};
  const trimmedModel = model.trim();
  if (provider?.trim()) return { provider: provider.trim(), model: trimmedModel };

  // Support legacy provider/model values supplied directly to the manager.
  const separator = trimmedModel.indexOf("/");
  if (separator > 0) {
    return {
      provider: trimmedModel.slice(0, separator),
      model: trimmedModel.slice(separator + 1),
    };
  }
  return { model: trimmedModel };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

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
