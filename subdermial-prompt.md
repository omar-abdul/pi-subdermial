# Subdermial - Initial Prompt / Specification

## What to Build

A multi-agent orchestrator extension for pi called **subdermial**. Turns pi into a conductor that spawns, monitors, and coordinates child agents running in isolated context windows.

The package lives at `~/pi-subdermial` and is installed as a pi package.

### User Commands

**`/agent`** — spawn a single subagent quickly

```
/agent "find all auth code" --tools read,grep,find --model haiku --profile scout
```

- Parses quoted or unquoted task text
- Optional flags: `--tools`, `--model`, `--profile`, `--cwd`
- Spawns agent asynchronously; results flow back to the orchestrator
- Widget updates live

**`/goal`** — set a multi-step objective for the orchestrator

```
/goal "implement Redis caching for the API"
/goal @./tasks/redis-plan.md
```

- Reads from inline text or a file
- Creates `goals/<id>/goal.md` with initial description
- Sends a crafted message to the orchestrator LLM telling it to:
  1. Read and expand `goal.md` with steps and success criteria
  2. Use `spawn_agent` tool to delegate each step
  3. Track progress in `progress.md`
  4. Check success criteria after each agent
- Max 20 agents per goal

**`/open-agent`** — reopen a completed/running agent's session in a new terminal

```
/open-agent
```

- Shows scrollable picker of all agents (with status icons, elapsed time, task preview)
- Detects terminal emulator (gnome-terminal, kitty, alacritty, macOS Terminal.app, etc.)
- Spawns `pi --session <agent-session-file>` in a new terminal window
- Orchestrator monitors the terminal PID and marks agent as "dead" when closed

**`/kill-agent <name>`** — kill a running agent
**`/agents`** — list all agents in current session

### LLM Tool

**`spawn_agent`** — callable by the orchestrator LLM

```
spawn_agent(task: "...", tools?: "read,edit", model?: "haiku", profile?: "scout")
```

- Blocks until agent completes (max 30 min)
- Call multiple times in one turn for parallel execution
- Returns compacted result to orchestrator LLM
- Streaming status updates every 3 seconds
- If `model` is omitted, selects from Pi's configured/authenticated model pool; falls back to the orchestrator's current model

### UI: Orchestrator Widget

Persistent status bar above the editor:

```
subdermial-agents ───────────────────────────
⏳ pensive-whale     (scout)   working...       2s
✓  wiry-bismuth      (worker)  completed        30s
✗  muddy-dove        (planner) errored: timeout 1m
◉  quiet-bear        (worker)  open             45s
───────────────────────────────────────────────
```

- ⏳ = running, ✓ = completed, ✗ = errored, ☠ = killed, ◉ = open
- Footer status shows aggregate counts: `agents: ⏳1 ◉1 ✓2`

### Naming

- 80 pre-generated `adjective-noun` pairs (e.g., `pensive-whale`, `wiry-bismuth`)
- Stored in `names.json`, copy-on-first-start to `~/.pi/agent/subdermial/`
- Drawn without replacement per session (no duplicate names)
- Pool regeneratable: `regenerateNamePool()` rewrites the JSON file
- Fallback: timestamp-based names if pool exhausted

### Agent Lifecycle

Each agent:

1. Gets a unique name from the pool
2. Gets its own session file at `~/.pi/agent/subdermial/sessions/<name>.jsonl`
3. Runs as a separate `pi --mode json -p --session <file>` subprocess
4. Has isolated context (doesn't see orchestrator's chat history)
5. Can use a different model and restricted tools
6. Returns compacted results to the orchestrator

Agent profiles (YAML frontmatter in `.md` files):

- **scout** — fast read-only recon (configured model, tools: read/grep/find/ls/bash)
- **worker** — general-purpose implementation (configured model, all tools)
- **planner** — creates implementation plans (configured model, read-only)
- **reviewer** — code review (configured model, read-only)

### Goal-Driven Workflow

1. `/goal` creates `goal.md` with user's description
2. Orchestrator LLM expands it with steps and success criteria
3. Orchestrator spawns agents via `spawn_agent`
4. After each agent, results appended to `progress.md`
5. Next agent receives `progress.md` as context
6. Orchestrator checks success criteria after each agent
7. Goal marked complete when all criteria met

### Persistence & Resumability

- Agent state serialized to orchestrator session via `pi.appendEntry("subdermial-store", ...)`
- On restart/resume, state restored from session entries
- Previously running agents marked as "killed" (processes don't survive restart)
- Active goals restored and notified to user
- Agent session files preserved at `~/.pi/agent/subdermial/sessions/`

### File Structure

```
~/pi-subdermial/
├── package.json              # pi package manifest
├── index.ts                  # Extension entry point
├── types.ts                  # Types (AgentState, GoalState, etc.)
├── agent-manager.ts          # Agent lifecycle: spawn, track, kill
├── goal-engine.ts            # Goals, progress tracking, validation
├── widget.ts                 # TUI status widget
├── name-generator.ts         # Random naming from pool
├── session-store.ts          # Persistence helpers
├── logger.ts                 # Debug logging
├── names.json                # 80 pre-generated names
├── commands/
│   ├── agent.ts              # /agent command
│   ├── goal.ts               # /goal command
│   └── open-agent.ts         # /open-agent command
├── tools/
│   └── spawn-agent.ts        # spawn_agent tool
└── agents/defaults/
    ├── scout.md, worker.md, planner.md, reviewer.md
```

### Limits

- Max 20 agents per session
- Max 4 concurrent agents
- Per-agent timeout: 30 minutes
- Names pool: 80 names

### Error Resilience

- Agent errors (✗) don't break the orchestrator — error recorded, orchestrator can retry or skip
- If orchestrator crashes/restarts, progress.md and session files survive
- Subprocess exit codes and stderr captured for diagnostics
- Abort signal (Esc) propagates to kill agent subprocesses

---

## Bugs Fixed During Development

### Bug 1: Duplicate `session_start` handlers (commit `fb9d01e`)

**Symptom:** Widget initialized twice on every session start, and an extraneous handler only fired on `reload`.

**Root cause:** Two separate `pi.on("session_start", ...)` registrations in `index.ts` — one for general restore logic and one that only ran on `event.reason === "reload"`.

**Fix:** Merged into a single handler. On reload, state restoration is skipped (the module is freshly loaded, but state was persisted before the reload triggered). Widget is always initialized.

### Bug 2: `names.json` not copied to runtime location (commit `fb9d01e`)

**Symptom:** `loadNamePool()` failed silently because the file was at `~/pi-subdermial/names.json` but the runtime looked in `~/.pi/agent/subdermial/names.json`.

**Root cause:** The bundled `names.json` lived in the package directory, but the name-generator loaded from the runtime data directory.

**Fix:** Added a startup copy-on-first-run: if `~/.pi/agent/subdermial/names.json` doesn't exist, copy it from `__dirname/names.json` (the bundled copy in the package).

### Bug 3: `const namesPath` declared twice (commit `3be8e0c`)

**Symptom:** TypeScript error — duplicate variable declaration in the same scope.

**Root cause:** `namesPath` was declared both in the "set up directories" block and again in the "load name pool" block.

**Fix:** Removed the first declaration.

### Bug 4: Agent subprocess couldn't find API key — dual root cause (commits `e73f919`, `e357bbe`, `75a0d2e`)

**Symptom:** Every spawned agent failed immediately with "No API key found for anthropic". Multiple attempts to fix.

**Root cause A (provider prefix):** The default model was `anthropic/claude-sonnet-4-5`. The subprocess pi resolved `anthropic/` to the direct Anthropic provider, which had no API key — the user's key was in `auth.json` under `openrouter`.

**Fix attempt 1:** Stripped provider prefix (`anthropic/claude-sonnet-4-5` → `claude-sonnet-4-5`). **Still failed** because pi resolves `claude-sonnet-4-5` to the Anthropic provider (it finds the model definition there) and ignores the `defaultProvider: openrouter` setting.

**Root cause B (no explicit `--provider`):** pi's `defaultProvider` setting only applies when a model can't be matched to a specific provider. Since `claude-sonnet-4-5` is an Anthropic model, pi always uses the Anthropic provider directly, regardless of `defaultProvider`.

**Final fix:** Resolve the provider and model from Pi's live model registry at spawn time. The extension now selects from configured/authenticated models (respecting scoped models), passes the selected provider explicitly to the child process, and passes the orchestrator's current model as a fallback when no configured model is available. Explicit `provider/model` requests are still honored. This avoids assuming Anthropic or OpenRouter and supports multiple subscriptions/API-key providers in the same Pi installation.

## My initial prompt

1. the ability to spawn multiple agents dynamically with either using a primitive like /agent or for a single agent or /goal -> which is something we will
   expand on
2. agents can be spawned with restrictvie tools such as saying when the agent is spawned dynamically, a list of tools which it can use will also be made
   to it, otherwise if no tools are passed assume access to all
3. in the main ui of which pi is called everytime an agent is spawned off we need an indicator that an agent is alive and working or its status so
   something like
   "subdermial-agent : working " with a little animation, or done, or errored out
4. nice and random naming of the agent, this will be acheieved by using a model to generate a file once, either json or whatever is the best format to
   write 50-100 double pairs that can later be concatenated this file can be updateed at anytime
5. that name will also be its identifier and it should not be duplicated or used for another agent within that session
6. if an agent errors out and it shows in the ui that it errored out then i should be able to use the /open-agent which will open a list of the agents
   used in that session, of which i can scroll pick and it will open that agent's history in a pi session in a new terminal
7. if i decide to work in that specific agent it, the original pi session ui, which we will deem henceforth the orchestrator , with which had the agents
   list's indicator that we spoke earlier will also be updated, so basically an open connection to that session doesnt end until the agent is killed
   8.killing the agent can be done by either the orchestrator or if i manually open that agent and then close its session then its dead
8. also there has to be a form of persistence of results, between the agents and the orchestrator
9. a /goal primitive where the goal is easily stated in prompt or can be read from an md file
10. what it will go is create a specific goal.md for that session with clear steps that state what the user wants, how to acheive it , and how to
    determine whether the goal is acheived or not, and by what means
11. what then the orchestrator will do is make a decision about which model to use for a specific task and spawn a subagent with the task that should be
    done
12. it will choose how many subagents it will require to fulfill the goal but also lets not make it possible to go above 20 agents
13. after a subagent has successfully or unsuccefully completed it will return a compacted list of things it has done or failed to do to the orchestrator,
    the orchestrator will take that output and write it to progress.md of that session in which the next agent it spawns it will add the progress.md to
    the context to the new agent
14. after every "done" or "error" from subagent, the orcheastrator will check to see if the goals were acheived using the condition it has put
15. safeguards for errors in subagents, if a subagent errors out the whole process shouldn't break,
16. resumability, and observabiltiy and persistence
17. create this as a spearate pi package in the home directory which you will install later
18. feel free to add anything sensible that you may think i have forgotten

_before you do anything review what i said and tell me what you understand it would look like_
