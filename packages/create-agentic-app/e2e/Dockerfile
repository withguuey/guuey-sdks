# Scaffolder clean-room gate-runner image.
#
# Just the toolchain + the repo source — no baked install/build. The
# ENTRYPOINT (scripts/run-gate.mjs, bind-mounted read-only by
# docker-compose.yml so it iterates without a rebuild) does
# `pnpm install --frozen-lockfile` + the cohort build + publish + scaffold
# itself, at container-run time — see that script for the full sequence.
#
# Build context is the REPO ROOT — see docker-compose.yml. Deps this build
# does not need (node_modules, .git, build caches, env files with secrets,
# …) are excluded via the sibling `Dockerfile.dockerignore`, which Docker
# BuildKit picks up automatically because it matches this Dockerfile's
# context-relative path (verified empirically against this repo's Docker
# 29.4 / Compose v2.40 — see e2e-task-1-report.md).
#
# node:24, not node:20: pnpm@11.2.2 (the version pinned by the root
# package.json#packageManager) hard-requires Node >=22.13 — it imports the
# `node:sqlite` builtin and crashes with ERR_UNKNOWN_BUILTIN_MODULE under
# Node 20. Separately, the workspace root package.json declares
# `"engines": {"node": ">=24.0.0"}` with `engine-strict=true` in the root
# .npmrc, so `pnpm install --frozen-lockfile` at repo root would refuse to
# proceed under anything older than 24 anyway. node:24-bookworm-slim
# satisfies both.
FROM node:24-bookworm-slim

# pnpm via corepack, pinned to the monorepo's version
# (package.json#packageManager — corepack reads it from the copied repo).
RUN corepack enable && corepack prepare pnpm@11.2.2 --activate

# git — `pnpm pack`/scaffold git-init steps need it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY . /build/

WORKDIR /gate
ENTRYPOINT ["node", "/gate/scripts/run-gate.mjs"]
