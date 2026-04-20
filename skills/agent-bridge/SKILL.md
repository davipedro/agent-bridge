---
name: agent-bridge
description: Delegate a task to another AI agent (Claude Code or Gemini CLI) running headless. Use when you need a second agent to handle a subtask, get a second opinion, or parallelize work across harnesses.
compatibility: Requires claude and/or gemini CLI in PATH. Node.js 18+. Run with: npx tsx scripts/bridge.ts
allowed-tools: Bash Read
---

# Agent Bridge

Delegates tasks to another AI agent running headless. Two modes:

- **Review mode** (default): compile → user reviews → execute. Use when the user wants to inspect the prompt before sending.
- **Auto mode**: compile + execute in one step, no review. Use when the user explicitly says to skip review or just wants the result.

---

## Step 1 — Collect information from the user

Ask the user for the following before proceeding:

1. **Harness:** `claude` or `gemini`
2. **Model:**
   - Claude: `claude-opus-4-7` | `claude-sonnet-4-6` | `claude-haiku-4-5` (default: `claude-sonnet-4-6`)
   - Gemini: `gemini-2.5-pro` | `gemini-2.5-flash` (default: `gemini-2.5-pro`)
3. **Execution type:** `analysis` (read-only) or `act` (read + write)
4. **Working directory:** absolute path where the destination agent will operate
5. **Task prompt:** what the destination agent should do
6. **Entry points** *(optional)*: relative paths to files the agent should read as context

---

## Step 2 — Compile the prompt

Run the bridge in background mode so you can continue working while it executes.

```bash
echo '<input-json>' | npx tsx scripts/bridge.ts
```

**Compile input:**
```json
{
  "action": "compile",
  "harness": "gemini",
  "model": "gemini-2.5-pro",
  "executionType": "analysis",
  "sessionId": null,
  "cwd": "/absolute/path/to/project",
  "prompt": "Find why auth.py fails on expired sessions",
  "entryPoints": ["src/auth.py"]
}
```

**Compile output:**
```json
{
  "action": "compile",
  "ok": true,
  "promptCompiled": "...",
  "next": "Review the compiled prompt above. When satisfied, call execute passing promptCompiled as-is or adjusted."
}
```

If `ok` is `false` and `error` is `file_not_found`, tell the user which entry point path was not found and ask for a correction.

---

## Step 3 — Review and confirm

Present `promptCompiled` to the user. Ask if they want to adjust anything before executing. Only proceed to execute when the user confirms.

---

## Step 4 — Execute

**CRITICAL:** Always call `compile` first. Never skip to execute without user review.

Run the bridge in background mode.

**Execute input:**
```json
{
  "action": "execute",
  "harness": "gemini",
  "model": "gemini-2.5-pro",
  "executionType": "analysis",
  "sessionId": null,
  "cwd": "/absolute/path/to/project",
  "promptCompiled": "<value from compile output, adjusted if needed>"
}
```

**Execute output:**
```json
{
  "action": "execute",
  "ok": true,
  "result": "...",
  "sessionId": "gemini-session-abc",
  "usage": { "inputTokens": 120, "outputTokens": 45 },
  "error": null
}
```

Store `sessionId` if you plan to continue the conversation with the same agent.

---

## Auto mode (skip review)

Use `action: "run"` when:
- The user explicitly says to skip review, or
- The task is straightforward and unambiguous — in this case, suggest skipping to the user before proceeding ("This looks simple — want me to skip review and run directly?")

The bridge compiles and executes internally — no intermediate step.

**Run input:**
```json
{
  "action": "run",
  "harness": "gemini",
  "model": "gemini-2.5-pro",
  "executionType": "analysis",
  "sessionId": null,
  "cwd": "/absolute/path/to/project",
  "prompt": "Find why auth.py fails on expired sessions",
  "entryPoints": ["src/auth.py"]
}
```

Output is identical to `execute`. Use this only when the user does not need to review the compiled prompt.

---

## Error handling

| `error` value | Meaning | Action |
|---|---|---|
| `quota` | Harness quota exhausted | Inform user, suggest switching harness |
| `auth` | CLI not authenticated | Ask user to run `claude login` or `gemini auth login` |
| `turn_limit` | Max turns reached | Session ended — next call should use `sessionId: null` |
| `unknown` | Unexpected failure | Surface raw error to user |

---

## Session management

- **New session:** `sessionId: null` — destination agent starts fresh
- **Resume session:** pass `sessionId` from previous execute output — agent resumes with full prior context
- **When to start new:** task is unrelated, cwd changed, or user requests fresh start
- **Compile with resume:** include `"session-resume"` context by passing the existing `sessionId` — the bridge injects the resume block automatically

---

## Working directory

**CRITICAL:** Before calling the bridge, confirm the working directory with the user. All operations on the destination agent will run relative to this path. Do not assume the current directory — ask explicitly if not provided.

---

## Background execution

Run the bridge script in the background so you can continue working while it executes. Use whatever background execution mechanism your harness provides.
