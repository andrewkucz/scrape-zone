# syntax=docker/dockerfile:1.7
# Production image: Hono server + built frontend + headless Chromium for the
# Playwright network capture.
#   docker build -t scrape-zone .

ARG NODE_VERSION=24
ARG PNPM_VERSION=12.10.1

# ---- base: Node + pnpm (Debian, not Alpine: Playwright's Chromium needs glibc) --
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /repo

# ---- build: type check and bundle the frontend into dist/ ---------------------
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm run build

# ---- deps: production node_modules only ----------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# ---- runtime -------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=deps --chown=node:node /repo/node_modules ./node_modules
# Chromium headless shell + its system libraries and fonts, pinned to the
# installed playwright version. tini reaps the browser's child processes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && node node_modules/playwright/cli.js install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --from=build --chown=node:node /repo/dist ./dist
USER node
EXPOSE 3000
# Any non-5xx (including the 401 from the password prompt) means it's up.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
# Node runs the TypeScript server directly (type stripping); no server build step.
CMD ["node", "server/index.ts"]
