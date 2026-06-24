/**
 * Subdermial type definitions
 */

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens?: number;
}

export type AgentStatus =
  | "pending"
  | "running"
  | "completed"
  | "errored"
  | "killed"
  | "open"
  | "dead";

export interface AgentState {
  /** Unique name (e.g. "pensive-whale") */
  id: string;
  /** Display name (same as id) */
  displayName: string;
  /** Current status */
  status: AgentStatus;
  /** What the agent was asked to do */
  task: string;
  /** Model identifier (e.g. "anthropic/claude-sonnet-4-5") */
  model?: string;
  /** Tools available to this agent */
  tools: string[];
  /** Path to agent's session file */
  sessionFile: string;
  /** Process ID (if running) */
  pid?: number;
  /** Terminal PID (if open via /open-agent) */
  terminalPid?: number;
  /** Timestamp when spawned (ms) */
  startTime: number;
  /** Timestamp when completed (ms) */
  endTime?: number;
  /** Compacted result text */
  result?: string;
  /** Error message if errored */
  error?: string;
  /** Stop reason from the agent process */
  stopReason?: string;
  /** Number of turns executed */
  turns: number;
  /** Aggregate token/cost usage */
  usage: AgentUsage;
  /** Agent profile name used (e.g. "scout", "worker") */
  profile?: string;
  /** Whether this agent is part of an active goal */
  goalId?: string;
}

export interface GoalStep {
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  agentId?: string;
}

export interface GoalState {
  /** Unique goal ID */
  id: string;
  /** Path to goal.md */
  goalPath: string;
  /** Path to progress.md */
  progressPath: string;
  /** Path to the goal directory */
  goalDir: string;
  /** User's original goal description */
  description: string;
  /** Decomposed steps */
  steps: GoalStep[];
  /** Success criteria */
  successCriteria: string[];
  /** Current status */
  status: "active" | "completed" | "failed";
  /** Agent IDs spawned for this goal */
  agentIds: string[];
  /** Orchestrator session ID this goal belongs to */
  orchestratorSessionId: string;
  /** Created timestamp */
  createdAt: number;
  /** Completed timestamp */
  completedAt?: number;
}

export interface SubdermialStore {
  /** Version for migration */
  version: number;
  /** Active agents (indexed by agent id) */
  agents: Record<string, AgentState>;
  /** Active goal (null if none) */
  activeGoal: GoalState | null;
  /** Completed goals history */
  completedGoals: GoalState[];
  /** Names used in this session (to avoid reuse) */
  usedNames: string[];
}

/**
 * Configuration that can be set by the user
 */
export interface SubdermialConfig {
  /** Maximum concurrent agents */
  maxConcurrency: number;
  /** Maximum total agents per session */
  maxAgents: number;
  /** Directory for agent session files */
  sessionsDir: string;
  /** Directory for goal files */
  goalsDir: string;
  /** Retry count on agent error */
  retryOnError: number;
  /** Default model for agents (if not specified) */
  defaultModel: string;
  /** Default provider for agents (e.g. "openrouter") */
  defaultProvider: string;
  /** Default agent profile */
  defaultProfile: string;
}