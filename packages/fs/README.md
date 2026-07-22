# `@guuey/fs`

> Dev-guidance helper for GuueyFS — the per-(app, user, session) filesystem
> every agent hosted on [guuey.com](https://guuey.com) runs inside. There is
> no wrapper API: **plain `node:fs` on the three paths below IS the
> contract.** This package just tells you where they are.

## Install

```sh
npm install @guuey/fs
# or
pnpm add @guuey/fs
```

## The three paths

Every hosted agent invoke runs with three directories bound in, one per
layer:

| Helper         | Layer     | Read/write         | Lifetime                                                                     |
| -------------- | --------- | ------------------ | ---------------------------------------------------------------------------- |
| `homeDir()`    | `home`    | read-write         | Durable, per (app, user) — survives restarts and new sessions.               |
| `appDir()`     | `app`     | read-only          | Shared across every user of the app; ships with the app, not per-user.       |
| `sessionDir()` | `session` | read-write (= cwd) | Scratch for THIS turn's session. Pod-local — does not survive a pod restart. |

```ts
import { homeDir, appDir, sessionDir } from "@guuey/fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

// Durable per-user memory — plain node:fs, nothing else.
const memoryPath = join(homeDir(), "memories", "MEMORY.md");
await mkdir(join(homeDir(), "memories"), { recursive: true });
await writeFile(memoryPath, "User prefers dark mode.\n", { flag: "a" });
const memory = await readFile(memoryPath, "utf8").catch(() => undefined);

// Shared, read-only per-app assets your build ships with the agent.
const template = await readFile(join(appDir(), "templates", "welcome.md"), "utf8");

// Scratch space for this session — sessionDir() IS process.cwd(), so plain
// relative paths already resolve here.
await writeFile("draft.txt", "working notes for this turn\n");
// equivalent: join(sessionDir(), "draft.txt")
```

Each helper throws a clear error if its env var isn't set — that's the
signal you're not running inside the guuey Router (`guuey dev` or the
hosted runtime). There's nothing to configure and nothing to catch
silently: either you're on a guuey pod and the paths are there, or you
aren't and the helper tells you so immediately.

## Memory behavior — the part that matters

Once the durable filesystem is enabled for an environment (the GuueyFS
rollout — operator-gated per env, see Status below), this is the target
contract:

- **Signed-in users**: `homeDir()` is durable cross-session memory. Files an
  agent writes today are there next week, from a different pod, after a
  restart.
- **Guests (anonymous sessions)**: `homeDir()` is still a real, writable
  directory — but it's backed by pod-local ephemeral scratch, not durable
  storage. Nothing a guest writes survives past the pod's lifetime. This is
  a deliberate platform boundary (guests never accumulate durable storage),
  not a bug — don't build a feature that assumes guest `homeDir()` writes
  persist.
- **`sessionDir()`** is pod-local scratch for every caller, guest or
  signed-in — by contract, not a deferred feature. Don't put anything there
  you need past the current session.

**Automatic recall is `claude-agent-sdk`-only today.** The three paths above
— including `homeDir()`'s durable-for-signed-in-users behavior — are the
same on every framework Guuey hosts. What's framework-scoped is the
Router's automatic recall: on `claude-agent-sdk`, the platform reads
`<home>/memories/MEMORY.md` before each turn and injects it into the
model's context for you, for free. On openai-agents-sdk and google-adk,
that automatic injection doesn't happen yet — an agent on those frameworks
can still read/write the same file with plain `node:fs` (as above), it just
has to do the reading itself. All-framework automatic recall arrives with
guuey's own memory MCP (a platform tool every framework calls over its
existing MCP channel). Separately: framework-native memory backends (e.g.
Google ADK's Vertex MemoryBank) are unsupported on Guuey — they store user
data outside guuey's deletion boundary, and there's no data-governance
policy for that yet.

Until the rollout reaches an environment, hosted agents there DO still get
`GUUEY_HOME_DIR`/`GUUEY_APP_DIR` — pointing at pod-local ephemeral storage.
Writes to `homeDir()` work, but nothing survives the pod: treat every layer
as session-lifetime until the durable filesystem is enabled for your
environment. The helpers' throw only signals you're outside the guuey
runtime entirely (no `guuey dev`, no hosted pod) — it is not a durability
signal.

## What this package is NOT

- **Not a storage adapter.** There's no `FsSource`, no versioning/CoW
  overlay, no read/write resolution logic to import. Base-path injection —
  the Router hands you three real directories — won that design; a client
  library on top of it would just be indirection.
- **Not a durability guarantee by itself.** The env vars are the contract;
  whether `homeDir()` is backed by durable storage depends on whether the
  durable filesystem is enabled for the environment AND whether the caller
  is signed in (see Memory behavior above) — this package can't change
  that, only report where the paths are.

## Status

🧪 **Developer preview (`0.x`).** The three-path shape (`home`/`app`/
`session`) and the env-var names (`GUUEY_HOME_DIR`, `GUUEY_APP_DIR`,
`process.cwd()`) are the actual production contract, not a preview of one —
code written against this package today keeps working unchanged when the
durable-filesystem rollout reaches your environment. What exists vs.
what's coming:

| Piece                                               | Status                                                     |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `homeDir()`/`appDir()`/`sessionDir()` helpers       | ✅ shipped                                                 |
| Env-var contract (`GUUEY_HOME_DIR`/`GUUEY_APP_DIR`) | ✅ shipped                                                 |
| Durable per-user `home` (signed-in users)           | 🔜 lands with the GuueyFS rollout (operator-gated per env) |
| Guest `home` = pod-local ephemeral                  | 🔜 lands with the GuueyFS rollout (operator-gated per env) |
| Per-user/per-app storage quotas                     | 🔜 enforced at the filesystem layer, not visible here      |

Until the rollout reaches an environment, the durable backing is off there
(`GUUEY_FS_BASE` unset) — but hosted agents still get the env vars, pointing
at pod-local ephemeral storage: writes work, nothing survives the pod (see
Memory behavior above).

This package is optional sugar — three one-line env-var reads. You can
skip it entirely and read `process.env.GUUEY_HOME_DIR` /
`process.env.GUUEY_APP_DIR` / `process.cwd()` yourself; nothing here is
magic.
