# todo-mcp — guuey hosted MCP server image.
#
# Self-sufficient multi-stage build: `guuey mcp deploy` packs this directory
# into a tarball and hands it straight to the builder with no external
# pre-build step and no build args — this Dockerfile installs its own deps
# and builds itself. (Different from guuey's own first-party MCP servers,
# which use a "copy-prebuilt" pattern that expects `dist/` + `node_modules/`
# to already exist before `docker build` runs — that pattern does not apply
# to a standalone project like this one.)
#
# Build + run locally:
#
#   docker build -t todo-mcp .
#   docker run -p 8080:8080 todo-mcp
#   curl http://localhost:8080/health
#
# Deploy to guuey:
#
#   cd mcps/todo && guuey mcp deploy

FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# guuey's hosted-MCP runtime injects PORT=8080 and probes GET /health at that
# port — this default matches so `docker run` alone also works.
ENV PORT=8080

COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 8080) + '/health').then(r => { if (!r.ok) throw 1 }).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
