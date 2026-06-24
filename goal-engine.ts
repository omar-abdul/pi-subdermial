/**
 * Goal Engine - manages goal-driven multi-agent workflows.
 *
 * Creates goal.md with decomposition, tracks progress in progress.md,
 * and validates completion against success criteria.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agent-manager";
import type { GoalState, GoalStep } from "./types";
import { info, error } from "./logger";

export class GoalEngine {
  private manager: AgentManager;
  private pi: ExtensionAPI;

  constructor(manager: AgentManager, pi: ExtensionAPI) {
    this.manager = manager;
    this.pi = pi;
  }

  /**
   * Create a new goal from a user description.
   * Returns the goal state. Actual decomposition is done by the orchestrator LLM.
   */
  async createGoal(description: string, goalsDir: string): Promise<GoalState> {
    const goalId = `goal-${Date.now().toString(36)}`;
    const goalDir = path.join(goalsDir, goalId);

    fs.mkdirSync(goalDir, { recursive: true });

    const goalPath = path.join(goalDir, "goal.md");
    const progressPath = path.join(goalDir, "progress.md");

    // Write initial goal.md - the orchestrator LLM will expand this
    const initialContent = `# Goal: ${description}

## Status: Planning

## Description
${description}

## Steps
*(To be filled by the orchestrator)*

## Success Criteria
*(To be defined by the orchestrator)*

## Strategy
*(How to achieve the goal - models, agent profiles, parallel vs sequential)*
`;
    fs.writeFileSync(goalPath, initialContent, "utf-8");

    // Write empty progress.md
    fs.writeFileSync(progressPath, "# Progress\n\n", "utf-8");

    const goal: GoalState = {
      id: goalId,
      goalPath,
      progressPath,
      goalDir,
      description,
      steps: [],
      successCriteria: [],
      status: "active",
      agentIds: [],
      orchestratorSessionId: "",
      createdAt: Date.now(),
    };

    this.manager.activeGoal = goal;
    this.manager.persist();
    info(`Goal created: ${goalId} - ${description}`);

    return goal;
  }

  /**
   * Append to progress.md after a subagent completes.
   */
  appendProgress(agentId: string, result: string, success: boolean): void {
    const goal = this.manager.activeGoal;
    if (!goal) return;

    const agent = this.manager.agents.get(agentId);
    const timestamp = new Date().toISOString();
    const status = success ? "✓ COMPLETED" : "✗ FAILED";

    const entry = `\n## ${status}: ${agentId} (${timestamp})\n\n**Task:** ${agent?.task || "unknown"}\n\n**Result:**\n${result}\n\n---\n`;

    try {
      fs.appendFileSync(goal.progressPath, entry, "utf-8");
      info(`Progress appended for ${agentId}`);
    } catch (err) {
      error(`Failed to append progress for ${agentId}`, err);
    }
  }

  /**
   * Build a system prompt for a goal-mode agent, including goal context and progress.
   */
  buildGoalAgentPrompt(goal: GoalState, task: string, agentProfile?: string): string {
    let prompt = "";

    // Read the full goal.md
    try {
      prompt += fs.readFileSync(goal.goalPath, "utf-8") + "\n\n";
    } catch {
      prompt += `# Goal: ${goal.description}\n\n`;
    }

    // Read progress so far
    try {
      const progress = fs.readFileSync(goal.progressPath, "utf-8");
      if (progress.trim()) {
        prompt += "## Progress So Far\n\n" + progress + "\n";
      }
    } catch {
      // No progress yet
    }

    prompt += `## Your Task\n\n${task}\n\n`;
    prompt += `When you finish, provide a clear summary of what you did and any files you changed.`;

    return prompt;
  }

  /**
   * Check if the goal's success criteria are met based on recent agent results.
   * This is called by the orchestrator LLM, but we provide the raw data.
   */
  getGoalStatus(): { met: boolean; summary: string } | null {
    const goal = this.manager.activeGoal;
    if (!goal) return null;

    const completedSteps = goal.steps.filter((s) => s.status === "completed").length;
    const totalSteps = goal.steps.length;
    const failedSteps = goal.steps.filter((s) => s.status === "failed").length;

    if (totalSteps === 0) {
      return { met: false, summary: "No steps defined yet." };
    }

    if (failedSteps > 0) {
      return {
        met: false,
        summary: `${completedSteps}/${totalSteps} steps completed, ${failedSteps} failed.`,
      };
    }

    if (completedSteps === totalSteps) {
      return { met: true, summary: `All ${totalSteps} steps completed successfully.` };
    }

    return {
      met: false,
      summary: `${completedSteps}/${totalSteps} steps completed.`,
    };
  }

  /**
   * Mark the goal as completed or failed.
   */
  completeGoal(success: boolean): void {
    const goal = this.manager.activeGoal;
    if (!goal) return;

    goal.status = success ? "completed" : "failed";
    goal.completedAt = Date.now();
    this.manager.persist();

    // Update goal.md status
    try {
      let content = fs.readFileSync(goal.goalPath, "utf-8");
      content = content.replace("## Status: Planning", `## Status: ${success ? "Completed" : "Failed"}`);
      content = content.replace("## Status: In Progress", `## Status: ${success ? "Completed" : "Failed"}`);
      fs.writeFileSync(goal.goalPath, content, "utf-8");
    } catch {
      // Non-critical
    }

    info(`Goal ${goal.id} ${success ? "completed" : "failed"}`);
  }

  /**
   * Get goal context to inject into the orchestrator's prompt.
   */
  getOrchestratorGoalContext(): string {
    const goal = this.manager.activeGoal;
    if (!goal) return "";

    const status = this.getGoalStatus();
    const progressContent = (() => {
      try {
        return fs.readFileSync(goal.progressPath, "utf-8");
      } catch {
        return "";
      }
    })();

    return `## Active Goal: ${goal.description}

**Status:** ${goal.status}
**Progress:** ${status?.summary || "Not started"}

### Goal File: ${goal.goalPath}
### Progress File: ${goal.progressPath}

${progressContent ? `### Recent Progress\n${progressContent.slice(-2000)}` : ""}`;
  }
}
