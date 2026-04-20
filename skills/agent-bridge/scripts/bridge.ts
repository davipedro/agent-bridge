/**
 * bridge.ts
 *
 * Input  (stdin): BridgeInput JSON
 * Output (stdout): BridgeCompileOutput | BridgeExecuteOutput JSON
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

// --- tipos base ---

type Harness = "claude" | "gemini";
type ExecutionType = "analysis" | "act";
type BridgeAction = "compile" | "execute" | "run";

// --- input ---

interface BridgeInputBase {
  action: BridgeAction;
  harness: Harness;
  model: string;
  executionType: ExecutionType;
  sessionId: string | null;
  cwd: string;
}

interface BridgeCompileInput extends BridgeInputBase {
  action: "compile";
  prompt: string;               // task prompt do orquestrador
  entryPoints?: string[];       // paths relativos ao cwd — validados e injetados inline

  // blocks?: string[];
  // Para evoluções futuras: array de blocos contextuais opcionais a injetar.
  // O bridge decide automaticamente os blocos fixos (system-prompt, output-contract)
  // e os automáticos (session-resume, tools). Novos blocos contextuais escolhidos
  // pelo orquestrador devem ser adicionados aqui e tratados em compilePrompt().
  // Exemplo: blocks: ["custom-context", "domain-rules"]
}

interface BridgeExecuteInput extends BridgeInputBase {
  action: "execute";
  promptCompiled: string;       // prompt já montado (pelo compile + ajustes do orquestrador)
}

interface BridgeRunInput extends BridgeInputBase {
  action: "run";
  prompt: string;               // task prompt — compile + execute em um passo
  entryPoints?: string[];
}

type BridgeInput = BridgeCompileInput | BridgeExecuteInput | BridgeRunInput;

// --- output ---

interface BridgeCompileOutput {
  action: "compile";
  ok: true;
  promptCompiled: string;
  next: string;
}

interface BridgeCompileError {
  action: "compile";
  ok: false;
  error: "file_not_found";
  path: string;
}

interface BridgeExecuteOutput {
  action: "execute";
  ok: boolean;
  result: string | null;
  sessionId: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  error: "quota" | "auth" | "turn_limit" | "unknown" | null;
}

type BridgeOutput = BridgeCompileOutput | BridgeCompileError | BridgeExecuteOutput;

// =============================================================================
// blocos de prompt
// =============================================================================

// --- fixos (sempre injetados) ---

function getSystemPrompt(): string {
  return `
You are a sub-agent invoked headlessly by an orchestrator agent via the agent-bridge skill.
You were not started by a human — a parent agent delegated this task to you programmatically.

## Behavioral rules

- Do not ask questions. If something is ambiguous, make the best judgment call and note your assumption in the Result.
- Do not expand the scope of the task. Complete exactly what was delegated, nothing more.
- Do not address the user directly. Your response is consumed by the orchestrator, not read by a human.
- If you encounter an unrecoverable error, describe it clearly in the Result so the orchestrator can handle it.

## Output

Always end your response with a \`## Result\` block. Do not omit it. Do not add content after it.
  `.trim();
}

function getOutputContract(): string {
  return `
## Output contract

End your response with a \`## Result\` block containing a valid JSON object. This is the only output the orchestrator parses.

\`\`\`json
{
  "summary": "<one or two sentences describing what was done or found>",
  "findings": [],
  "files_changed": [],
  "confidence": "high | medium | low"
}
\`\`\`

**Fields:**

- \`summary\` — required. One or two sentences for the orchestrator to relay to the user.
- \`findings\` — list of observations, issues, or recommendations. Each entry is a string. Empty if nothing relevant was found.
- \`files_changed\` — list of absolute paths of files created, modified, or deleted. Empty if no files were changed.
- \`confidence\` — required. \`high\` if task completed fully with no assumptions. \`medium\` if assumptions were made (note them in summary). \`low\` if result is partial or uncertain (explain in summary).

**Rules:**
- The JSON must be valid and parseable.
- Do not omit fields — use empty arrays when not applicable.
- Do not add any content after the \`## Result\` block.
  `.trim();
}

// --- contextuais (orquestrador seleciona via blocks[]) ---


function getSessionResume(sessionId: string): string {
  return `
## Session resume

You are resuming session ${sessionId}. Your previous context is preserved.
Focus only on the new task delta below — do not repeat work already done in this session.
  `.trim();
}

// --- resources ---

// tools: apenas para gemini — claude usa flags de invocação (--allowedTools / --permission-mode)
function getReadonlyTools(): string {
  return `
## Execution mode: analysis (read-only)

You are operating in analysis mode. You may only perform read operations.

**Allowed:**
- Reading files and directories
- Searching file contents
- Running non-destructive shell commands (e.g. ls, find, cat, git log, git diff, grep)

**Not allowed:**
- Creating, editing, or deleting files
- Running commands with side effects (e.g. git commit, npm install, rm)
- Making any changes to the codebase or environment

If completing the task would require making changes, describe what should be changed in \`findings\` instead of doing it. Leave \`files_changed\` empty.
  `.trim();
}

function getActTools(): string {
  return `
## Execution mode: act (read + write)

You are operating in act mode. You may read and modify the codebase.

**Allowed:**
- Reading files and directories
- Searching file contents
- Creating, editing, and deleting files
- Running shell commands, including those with side effects

**Expected:**
- Report every file you create, modify, or delete in \`files_changed\` using absolute paths.
- If a change would be irreversible or high-risk and you are uncertain, describe it in \`findings\` instead of executing it.
  `.trim();
}

function getEntryPoints(files: { relativePath: string; content: string }[]): string {
  if (files.length === 0) return "";
  const sections = files.map(({ relativePath, content }) =>
    `### ${relativePath}\n\`\`\`\n${content}\n\`\`\``
  );
  return `## Reference files\n\n${sections.join("\n\n")}`;
}


// =============================================================================
// compile
// =============================================================================

function compilePrompt(input: BridgeCompileInput): BridgeCompileOutput | BridgeCompileError {
  // validar entry points antes de montar o prompt
  const resolvedEntryPoints: { relativePath: string; content: string }[] = [];
  for (const relativePath of input.entryPoints ?? []) {
    const absolutePath = path.join(input.cwd, relativePath);
    if (!fs.existsSync(absolutePath)) {
      return { action: "compile", ok: false, error: "file_not_found", path: relativePath };
    }
    resolvedEntryPoints.push({ relativePath, content: fs.readFileSync(absolutePath, "utf8") });
  }

  const parts: string[] = [];

  // fixos — sempre primeiro
  parts.push(getSystemPrompt());

  // automáticos por contexto
  if (input.sessionId) parts.push(getSessionResume(input.sessionId));

  // extensão futura: if (input.blocks?.includes("custom-context")) parts.push(getCustomContext());

  // tools — só para gemini; claude é controlado por flags no execute
  if (input.harness === "gemini") {
    if (input.executionType === "analysis") parts.push(getReadonlyTools());
    if (input.executionType === "act")      parts.push(getActTools());
  }

  // entry points — arquivos de referência injetados inline
  if (resolvedEntryPoints.length > 0) parts.push(getEntryPoints(resolvedEntryPoints));

  // fixo — sempre antes do task prompt
  parts.push(getOutputContract());

  // task prompt
  parts.push(input.prompt);

  return {
    action: "compile",
    ok: true,
    promptCompiled: parts.filter(Boolean).join("\n\n"),
    next: "Review the compiled prompt above. When satisfied, call execute passing promptCompiled as-is or adjusted.",
  };
}

// =============================================================================
// parse helpers (extraídos de paperclip/gemini-quota/parse.ts)
// =============================================================================

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch { /* skip */ }
  return null;
}

function asStr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function asNum(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function readSessionId(event: Record<string, unknown>): string | null {
  return (
    asStr(event.session_id).trim() ||
    asStr(event.sessionId).trim() ||
    asStr(event.checkpoint_id).trim() ||
    null
  );
}

function collectText(event: Record<string, unknown>): string {
  const msg = event.message;
  if (typeof msg === "string") return msg.trim();
  if (typeof msg === "object" && msg !== null) {
    const m = msg as Record<string, unknown>;
    const direct = asStr(m.text).trim();
    if (direct) return direct;
    const content = Array.isArray(m.content) ? m.content : [];
    return content
      .map((p: unknown) => {
        const part = (typeof p === "object" && p !== null ? p : {}) as Record<string, unknown>;
        return asStr(part.text).trim() || asStr(part.content).trim();
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return asStr(event.result).trim() || asStr(event.response).trim();
}

function parseJsonl(stdout: string): {
  sessionId: string | null;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  errorMessage: string | null;
  resultEvent: Record<string, unknown> | null;
} {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let resultEvent: Record<string, unknown> | null = null;

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const event = parseJsonLine(line);
    if (!event) continue;

    const found = readSessionId(event);
    if (found) sessionId = found;

    const type = asStr(event.type).trim();

    if (type === "assistant" || type === "text" || (type === "message" && asStr(event.role) === "assistant")) {
      const text = typeof event.content === "string" ? event.content.trim() : collectText(event);
      if (text) messages.push(text);
      continue;
    }

    if (type === "result") {
      resultEvent = event;
      // Gemini uses event.stats; Claude uses event.usage
      const u = (typeof event.usage === "object" && event.usage !== null ? event.usage
               : typeof event.stats  === "object" && event.stats  !== null ? event.stats
               : {}) as Record<string, unknown>;
      inputTokens += asNum(u.input_tokens, asNum(u.inputTokens, asNum(u.promptTokenCount)));
      outputTokens += asNum(u.output_tokens, asNum(u.outputTokens, asNum(u.candidatesTokenCount)));
      const text = collectText(event);
      if (text && messages.length === 0) messages.push(text);
      if (event.is_error === true || asStr(event.subtype).toLowerCase() === "error") {
        errorMessage = asStr(event.error || event.message || event.result).trim() || errorMessage;
      }
      continue;
    }

    if (type === "error" || (type === "system" && asStr(event.subtype).toLowerCase() === "error")) {
      errorMessage = asStr(event.error || event.message || event.detail).trim() || errorMessage;
      continue;
    }

    if (type === "step_finish" || event.usage || event.stats) {
      const u = (typeof event.usage === "object" && event.usage !== null ? event.usage
               : typeof event.stats  === "object" && event.stats  !== null ? event.stats
               : {}) as Record<string, unknown>;
      inputTokens += asNum(u.input_tokens, asNum(u.inputTokens));
      outputTokens += asNum(u.output_tokens, asNum(u.outputTokens));
    }
  }

  return { sessionId, summary: messages.join("\n\n").trim(), inputTokens, outputTokens, errorMessage, resultEvent };
}

const QUOTA_RE = /resource_exhausted|quota|rate[-\s]?limit|too many requests|\b429\b|billing details/i;
const AUTH_RE  = /not\s+authenticated|api[_ ]?key\s+(required|missing|invalid)|unauthorized|not\s+logged\s+in|login\s+required/i;

function detectError(
  stdout: string,
  stderr: string,
  exitCode: number | null,
  resultEvent: Record<string, unknown> | null,
): BridgeExecuteOutput["error"] {
  if (exitCode === 53) return "turn_limit";
  const haystack = `${stdout}\n${stderr}`;
  if (QUOTA_RE.test(haystack)) return "quota";
  if (AUTH_RE.test(haystack))  return "auth";
  if (exitCode !== 0)          return "unknown";
  return null;
}

// =============================================================================
// execute
// =============================================================================

async function executeHarness(input: BridgeExecuteInput): Promise<BridgeExecuteOutput> {
  const { harness, executionType, sessionId, cwd, model, promptCompiled } = input;

  let command: string;
  let args: string[];

  if (harness === "claude") {
    const permissionMode = executionType === "analysis" ? "dontAsk" : "acceptEdits";
    command = "claude";
    args = [
      "--print", "-",
      "--output-format", "stream-json",
      "--model", model,
      "--permission-mode", permissionMode,
    ];
    if (sessionId) args.push("--resume", sessionId);
  } else {
    command = "gemini";
    args = [
      "--output-format", "stream-json",
      "--approval-mode", "yolo",
      "--model", model,
      "--prompt", promptCompiled,
    ];
    if (sessionId) args.push("--resume", sessionId);
  }

  const proc = spawn(command, args, { cwd, env: process.env });

  if (harness === "claude") {
    proc.stdin.write(promptCompiled);
    proc.stdin.end();
  }

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

  const [exitCode] = await once(proc, "close") as [number | null];

  const parsed = parseJsonl(stdout);
  const error = detectError(stdout, stderr, exitCode, parsed.resultEvent);

  return {
    action: "execute",
    ok: error === null,
    result: parsed.summary || null,
    sessionId: parsed.sessionId,
    usage: { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens },
    error,
  };
}

// =============================================================================
// main
// =============================================================================

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input: BridgeInput = JSON.parse(Buffer.concat(chunks).toString("utf8"));

  let output: BridgeOutput;

  if (input.action === "compile") {
    output = compilePrompt(input);
  } else if (input.action === "run") {
    const compiled = compilePrompt({ ...input, action: "compile" });
    if (!compiled.ok) {
      output = compiled;
    } else {
      output = await executeHarness({ ...input, action: "execute", promptCompiled: compiled.promptCompiled });
    }
  } else {
    output = await executeHarness(input);
  }

  process.stdout.write(JSON.stringify(output) + "\n");
}

main().catch((err) => {
  process.stderr.write(String(err) + "\n");
  process.exit(1);
});
