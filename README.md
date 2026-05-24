# `oss/` — open-source surface

Subtree-root for the open-source half of guuey. Everything under here is
either already published to npm under `@guuey/*` OR will be once it
stabilizes.

Mirrors the `oss/` layout in [`loqu-co/ggui`](https://github.com/loqu-co/ggui)
so cross-repo conventions stay consistent.

## Layout

| Path                 | Contents                                   | Status                   |
| -------------------- | ------------------------------------------ | ------------------------ |
| `oss/packages/*`     | Publishable `@guuey/*` libraries           | Subtree root (planned)   |
| `oss/packages/cli`   | `@guuey/cli` — the `guuey` binary          | ✅ published (slice 3.0) |
| `oss/packages/state` | `@guuey/state` — KV scoped per (user, mcp) | 🚧 sketch (slice 4.0)    |

## Subtree to `github.com/ggui-ai/guuey-sdks` (planned, not wired)

Goal: a separate public repo (`github.com/ggui-ai/guuey-sdks`) mirrors
`oss/packages/` via `git subtree split` + push. Public contributors
PR against `guuey-sdks`; we pull changes back here via subtree merge.

When the subtree is set up, the relevant CI workflows (modeled on
`loqu-co/ggui`'s `.github/workflows/ff-subtree-oss.yml`) will:

- On push to `main`: split `oss/packages/` and force-push to the public
  repo's tracking branch.
- On PR to `oss/packages/*`: verify the subtree path stays valid (no
  closed-side imports leak in).
- On publish trigger: build + publish to npm from the public mirror.

Until then, edits land here directly and `@guuey/cli` is published
manually (see `.github/workflows/cli-release.yml`).

## Rules for code in `oss/packages/`

- **No imports from `private/*`, `backend/*`, or `apps/*`.** The OSS
  side compiles standalone — no closed-monorepo paths.
- **No `@guuey-private/*` deps.** Only `@guuey/*` cross-package deps,
  `@ggui-ai/*` (from npm), and standard ecosystem packages.
- **Open license** (MIT). Closed code stays in `private/` / `backend/`.
- **`packageManager: "@guuey/*"` only.** Don't use `@guuey-apps/*` or
  `@guuey-private/*` scope here.
- **Standard tsconfig + Node-only.** Browser-targeted libraries declare
  the `browser` condition explicitly in `exports`.

When in doubt: would this code work if checked out as a standalone
github.com/ggui-ai/guuey-sdks clone with no access to this monorepo?
If yes, it belongs in `oss/`. If no, it belongs in `private/` or
`backend/`.
