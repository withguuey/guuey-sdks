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

## What this package is NOT

- **Not a storage adapter.** There's no `FsSource`, no versioning/CoW
  overlay, no read/write resolution logic to import. Base-path injection —
  the Router hands you three real directories — won that design; a client
  library on top of it would just be indirection.
- **Not a durability guarantee by itself.** The env vars are the contract;
  whether `homeDir()` is backed by durable storage depends on whether the
  caller is signed in (see above) — this package can't change that, only
  report where the paths are.

## Status

🧪 **Developer preview (`0.x`).** The three-path shape (`home`/`app`/
`session`) and the env-var names (`GUUEY_HOME_DIR`, `GUUEY_APP_DIR`,
`process.cwd()`) are the actual production contract, not a preview of one —
this package ships alongside the durable-filesystem slice, not ahead of it.

| Piece                                         | Status                                                |
| --------------------------------------------- | ----------------------------------------------------- |
| `homeDir()`/`appDir()`/`sessionDir()` helpers | ✅ shipped                                            |
| Durable per-user `home` (signed-in users)     | ✅ shipped                                            |
| Guest `home` = pod-local ephemeral            | ✅ shipped (by design, not TBD)                       |
| Per-user/per-app storage quotas               | 🔜 enforced at the filesystem layer, not visible here |

This package is optional sugar — three one-line env-var reads. You can
skip it entirely and read `process.env.GUUEY_HOME_DIR` /
`process.env.GUUEY_APP_DIR` / `process.cwd()` yourself; nothing here is
magic.
