# agent-bridge

The bridge across agents — delegate tasks to another AI agent running headless.

## Supported CLIs

| CLI | Harness key |
|-----|-------------|
| [Claude Code](https://claude.ai/code) | `claude` |
| [Gemini CLI](https://geminicli.com) | `gemini` |

## What it does

`agent-bridge` is an agent skill that lets an orchestrator agent delegate tasks to another AI agent running headlessly. It assembles a structured prompt, optionally shows it for review, then spawns the target CLI and returns the result.

Supports two modes:
- **Review mode** — compile → inspect → execute
- **Auto mode** — compile + execute in one step, no review

## Install

```bash
npx skills add davipedro/agent-bridge
```

Or copy `skills/agent-bridge/` into your project's `.claude/skills/` directory.

## Requirements

- Node.js 18+
- `claude` and/or `gemini` CLI in PATH and authenticated

## Usage

Invoke with `/agent-bridge` in Claude Code. The skill guides you through:

1. Harness (`claude` or `gemini`), model, execution type, working directory, task prompt
2. Prompt review (or skip with auto mode)
3. Execution and result

### Auto mode (no review)

```json
{
  "action": "run",
  "harness": "gemini",
  "model": "gemini-2.5-pro",
  "executionType": "analysis",
  "sessionId": null,
  "cwd": "/absolute/path/to/project",
  "prompt": "Find why auth.py fails on expired sessions"
}
```

### Manual compile + execute

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

Then pass `promptCompiled` to `action: "execute"` after reviewing.

## Actions

| Action | Description |
|--------|-------------|
| `compile` | Assembles the full prompt. Returns `promptCompiled` for review. |
| `execute` | Runs the compiled prompt against the target harness. |
| `run` | Compile + execute in one step. No review. |

## Execution types

| Type | Permissions |
|------|------------|
| `analysis` | Read-only. No file writes or side-effect commands. |
| `act` | Read + write. Full tool access. |

## Session management

Pass `sessionId` from a previous `execute`/`run` output to resume the same agent session. Set to `null` to start fresh.

## Script

The bridge script is at `skills/agent-bridge/scripts/bridge.ts`. Run directly with:

```bash
echo '<input-json>' | npx tsx skills/agent-bridge/scripts/bridge.ts
```
