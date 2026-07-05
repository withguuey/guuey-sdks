#!/usr/bin/env node
// Stage-2 local e2e turn — boots the SCAFFOLDED app's own dev loop headless
// (`guuey dev --serve` via the app's devDep CLI + the todo MCP), POSTs one
// turn to /agent/invoke and asserts the SSE frames. Runs inside the
// clean-room gate-runner (see ./run-gate.mjs) after the scaffold builds;
// also runnable on the host against any scaffolded app dir.
//
//   node local-turn.mjs <appDir> [--real-llm]
//
// KEYLESS mode (default — the CI gate): swaps the app's worker for the
// CLI's keyless fixture worker (`oss/packages/cli/src/dev/fixtures/
// echo-worker.mjs` — echoes the invoke as one native event, zero network
// calls) via the platform's own `guuey.json#worker` raw-string escape hatch
// (see `oss/packages/cli/src/commands/dev.ts` — a template-authored
// override outside the zod schema), plus `protocol: "bypass"` so the native
// echo event is relayed verbatim as a `message` frame (the CLI's own
// dev-server test contract for this fixture; the default `silver` protocol
// would push the fixture's non-SDK event into a real framework normalizer).
// `guuey dev` preflights the framework's LLM key (env or .env.local —
// dev.ts:115) BEFORE it knows the worker is a fixture, so a clearly-fake
// dummy value is injected into the child env when no real key is present —
// safe ONLY because the fixture worker never makes a network call, and
// disclosed in the e2e-task-2 report. guuey.json is restored afterwards.
//
// --real-llm (claude-agent-sdk apps only; requires a non-empty
// ANTHROPIC_API_KEY): drives the REAL scaffolded worker end-to-end —
// worker → Claude → MCP tool call against the booted todo MCP — and asserts
// at least one AgJSON tool signal (`tool.start` event or `tool-call` block)
// for a `todo_*` tool, then `done`.
//
// Teardown (always, in `finally`): SIGTERM both children's process groups
// (they are spawned detached, so each owns its group — `pnpm exec` spawns
// grandchildren a bare child.kill() would orphan), SIGKILL backstop,
// guuey.json restored, fixture copy removed.
import { spawn } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Defaults match the scaffolded dev loop (scripts/dev.mjs). Overridable for
// host runs where another dev stack already squats them — inside the
// gate-runner container (own network namespace) the defaults are always
// free. A non-default todo port is propagated into `guuey.json`'s
// `mcpServers.todo.devPort` (restored after) so the lowered snapshot the
// worker receives points at the right place.
const AGENT_PORT = Number(process.env.GUUEY_E2E_AGENT_PORT ?? 6790);
const TODO_PORT = Number(process.env.GUUEY_E2E_TODO_PORT ?? 6782);

// Same env-var-per-framework map as `guuey dev`'s key preflight
// (oss/packages/cli/src/commands/dev.ts KEY_ENV_VAR).
const KEY_ENV_VAR = {
  "claude-agent-sdk": "ANTHROPIC_API_KEY",
  "openai-agents-sdk": "OPENAI_API_KEY",
};

const [appDirArg, ...rest] = process.argv.slice(2);
if (!appDirArg) {
  console.error("usage: local-turn.mjs <appDir> [--real-llm]");
  process.exit(2);
}
const appDir = resolve(appDirArg);
const realLlm = rest.includes("--real-llm");

// Repo root: GUUEY_REPO_ROOT when set (the gate-runner passes /build — this
// script is bind-mounted at /gate/scripts, outside the repo tree); on the
// host, resolve relative to this file's in-repo location.
const repoRoot =
  process.env.GUUEY_REPO_ROOT ?? resolve(import.meta.dirname, "../../../../..");
const fixtureSrc = join(repoRoot, "oss/packages/cli/src/dev/fixtures/echo-worker.mjs");

const guueyJsonPath = join(appDir, "guuey.json");
const rawGuueyJson = readFileSync(guueyJsonPath, "utf8");
const guueyDoc = JSON.parse(rawGuueyJson);
const framework = guueyDoc.agent?.framework ?? "claude-agent-sdk";
const keyVar = KEY_ENV_VAR[framework];
if (!keyVar) throw new Error(`unsupported framework "${framework}"`);

if (realLlm) {
  if (framework !== "claude-agent-sdk") {
    throw new Error(`--real-llm only supports claude-agent-sdk (got "${framework}")`);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("--real-llm requires a non-empty ANTHROPIC_API_KEY");
  }
}

// ── child-process helpers (process-group discipline) ────────────────────────

const children = [];

function boot(name, command, args, opts = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group — teardown signals the whole tree
    ...opts,
  });
  const prefix = `[local-turn:${name}] `;
  child.stdout?.on("data", (d) => process.stdout.write(String(d).replace(/^/gm, prefix)));
  child.stderr?.on("data", (d) => process.stderr.write(String(d).replace(/^/gm, prefix)));
  children.push({ name, child });
  return child;
}

function signalGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch (e) {
    if (e.code !== "ESRCH") {
      console.warn(`[local-turn] failed to ${sig} process group ${pid}: ${e.code ?? e}`);
    }
  }
}

async function killGroup({ name, child }) {
  if (!child.pid || child.exitCode !== null) return;
  console.log(`[local-turn] stopping ${name} (pgid ${child.pid})`);
  signalGroup(child.pid, "SIGTERM");
  await new Promise((done) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      done();
    };
    child.once("exit", finish);
    setTimeout(() => {
      if (child.exitCode === null) signalGroup(child.pid, "SIGKILL");
      finish();
    }, 8_000).unref();
  });
}

async function waitForHttp(url, deadlineMs, what) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    for (const { name, child } of children) {
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error(`${name} exited early (code ${child.exitCode}) while waiting for ${what}`);
      }
    }
    try {
      // ANY completed HTTP response means the server is accepting — the todo
      // MCP's /mcp answers non-200 to a bare GET, which is still "up".
      const res = await fetch(url);
      await res.body?.cancel?.();
      return;
    } catch {
      // Connection refused — not up yet.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${what} never became reachable at ${url}`);
}

// ── SSE turn ────────────────────────────────────────────────────────────────

/** POST one turn and parse the SSE stream into `[{event, data}]` frames. */
async function postTurn(input, timeoutMs) {
  const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/agent/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) {
    throw new Error(`/agent/invoke answered ${res.status}: ${await res.text()}`);
  }
  const text = await res.text(); // stream ends when the server res.end()s
  const frames = [];
  for (const chunk of text.split("\n\n")) {
    const eventLine = chunk.split("\n").find((l) => l.startsWith("event: "));
    const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
    if (!eventLine || !dataLine) continue;
    frames.push({
      event: eventLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length)),
    });
  }
  return frames;
}

function assertFrame(cond, message, frames) {
  if (cond) return;
  console.error(`[local-turn] FRAMES:\n${JSON.stringify(frames, null, 2).slice(0, 8_000)}`);
  throw new Error(`assertion failed: ${message}`);
}

/** Recursively scan a value for an AgJSON tool signal (`tool.start` event or
 *  `tool-call` block) whose name references a `todo_*` tool. SDK-namespaced
 *  MCP tool names (`mcp__todo__todo_create`) count. */
function hasTodoToolSignal(value) {
  if (Array.isArray(value)) return value.some(hasTodoToolSignal);
  if (typeof value !== "object" || value === null) return false;
  const { type, name } = value;
  if (
    (type === "tool.start" || type === "tool-call") &&
    typeof name === "string" &&
    name.includes("todo_")
  ) {
    return true;
  }
  return Object.values(value).some(hasTodoToolSignal);
}

// ── main ────────────────────────────────────────────────────────────────────

/** Fail fast when a target port is already taken (e.g. a host `pnpm dev`
 *  stack) — otherwise waitForHttp would happily accept the SQUATTER's
 *  responses and the turn would hit the wrong server. */
async function assertPortFree(port, what, overrideVar) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1_000),
    });
    await res.body?.cancel?.();
  } catch {
    return; // connection refused/timeout — free
  }
  throw new Error(
    `port ${port} (${what}) is already in use — stop the other server or set ${overrideVar}`,
  );
}

const fixtureCopy = join(appDir, "echo-worker.e2e.mjs");
let guueyJsonDirty = false;

try {
  await assertPortFree(AGENT_PORT, "guuey dev", "GUUEY_E2E_AGENT_PORT");
  await assertPortFree(TODO_PORT, "todo MCP", "GUUEY_E2E_TODO_PORT");

  // guuey.json edits (restored in `finally`): the fixture-worker swap via
  // the raw `worker` field + bypass protocol (keyless mode), and the todo
  // devPort when overridden (both modes).
  const edited = structuredClone(guueyDoc);
  let editCount = 0;
  if (!realLlm) {
    copyFileSync(fixtureSrc, fixtureCopy);
    edited.worker = "./echo-worker.e2e.mjs";
    edited.protocol = "bypass";
    editCount += 1;
  }
  if (edited.agent?.mcpServers?.todo && edited.agent.mcpServers.todo.devPort !== TODO_PORT) {
    edited.agent.mcpServers.todo.devPort = TODO_PORT;
    editCount += 1;
  }
  if (editCount > 0) {
    writeFileSync(guueyJsonPath, JSON.stringify(edited, null, 2) + "\n");
    guueyJsonDirty = true;
  }

  // Hermetic agent env, two adjustments over the ambient env:
  //
  // 1. Scrub every CLAUDE* var. When this runs on a host inside a Claude
  //    Code session, the scaffolded worker's own claude-agent-sdk `query()`
  //    spawns a CLI child that sees CLAUDE_CODE_SSE_PORT & co. and ATTACHES
  //    to the interactive session's harness — the model then gets that
  //    session's tools instead of the app's MCP servers (observed: the turn
  //    called the session's ToolSearch and never saw the todo MCP). The
  //    gate-runner container has none of these; scrubbing makes host runs
  //    match it.
  // 2. Keyless: satisfy `guuey dev`'s key preflight with a clearly-fake
  //    value. The fixture worker never reads it and never calls out; a real
  //    key in the ambient env (or the app's .env.local) is left untouched.
  const agentEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")),
  );
  if (!agentEnv[keyVar]) agentEnv[keyVar] = "keyless-fixture-dummy-never-sent-anywhere";

  console.log(`[local-turn] booting todo MCP on :${TODO_PORT}`);
  boot("todo", "corepack", ["pnpm", "start"], {
    cwd: join(appDir, "mcps/todo"),
    env: { ...process.env, PORT: String(TODO_PORT) },
  });

  console.log(`[local-turn] booting guuey dev --serve on :${AGENT_PORT} (${framework})`);
  boot("agent", "corepack", ["pnpm", "exec", "guuey", "dev", "--serve", "--port", String(AGENT_PORT)], {
    cwd: appDir,
    env: agentEnv,
  });

  await waitForHttp(`http://127.0.0.1:${TODO_PORT}/mcp`, 60_000, "todo MCP");
  await waitForHttp(`http://127.0.0.1:${AGENT_PORT}/healthz`, 60_000, "guuey dev server");
  console.log("[local-turn] both servers up");

  if (!realLlm) {
    const input = "hello clean room";
    console.log(`[local-turn] keyless turn: POST ${JSON.stringify(input)}`);
    const frames = await postTurn(input, 120_000);

    assertFrame(frames.length >= 3, "expected at least session/message/done frames", frames);
    assertFrame(frames[0].event === "session", "first frame must be `session`", frames);
    assertFrame(
      typeof frames[0].data.sessionId === "string",
      "session frame carries a sessionId",
      frames,
    );
    const echoFrame = frames.find(
      (f) => f.event === "message" && JSON.stringify(f.data).includes(`"echo":${JSON.stringify(input)}`),
    );
    assertFrame(
      echoFrame !== undefined,
      "a `message` frame relays the fixture worker's echo of the input",
      frames,
    );
    const last = frames.at(-1);
    assertFrame(
      last.event === "done" && last.data.stopReason === "end_turn",
      "final frame is `done` with stopReason end_turn",
      frames,
    );
    console.log("[local-turn] ✓ keyless fixture turn: session → message(echo) → done");
  } else {
    const input =
      "Create a todo titled 'clean-room proof' using your todo tools, then tell me it is created.";
    console.log(`[local-turn] real-LLM turn: POST ${JSON.stringify(input)}`);
    const frames = await postTurn(input, 300_000);

    assertFrame(frames[0]?.event === "session", "first frame must be `session`", frames);
    const messageFrames = frames.filter((f) => f.event === "message");
    assertFrame(messageFrames.length >= 1, "expected at least one AgJSON `message` frame", frames);
    assertFrame(
      messageFrames.some((f) => hasTodoToolSignal(f.data)),
      "an AgJSON `message` frame contains a tool signal for a todo_* tool",
      frames,
    );
    const last = frames.at(-1);
    assertFrame(last.event === "done", "final frame is `done`", frames);
    assertFrame(last.data.stopReason === "end_turn", "done stopReason is end_turn", frames);
    console.log("[local-turn] ✓ real-LLM turn: session → message(todo_* tool) → done");
  }
} finally {
  for (const entry of children) await killGroup(entry);
  if (guueyJsonDirty) writeFileSync(guueyJsonPath, rawGuueyJson);
  if (existsSync(fixtureCopy)) rmSync(fixtureCopy);
}
