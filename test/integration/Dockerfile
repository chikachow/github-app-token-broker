FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN npm install --global "$(node -p 'require("./package.json").packageManager')"
ENV CI=true CLOUDFLARE_CF_FETCH_ENABLED=false WRANGLER_SEND_METRICS=false WRANGLER_LOG_PATH=/tmp/wrangler-logs WRANGLER_REGISTRY_PATH=/tmp/wrangler-registry

RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile && node --run build
RUN pnpm --filter @github-app-token-broker/integration-fastify deploy --prod /fastify
RUN node node_modules/wrangler/bin/wrangler.js deploy test/integration/worker.ts \
    --config workers/github-app-token-broker/wrangler.jsonc \
    --dry-run --outdir test/integration/dist/worker/normal \
    --name integration-worker-normal
RUN node node_modules/wrangler/bin/wrangler.js deploy test/integration/worker-observation-failure.ts \
    --config workers/github-app-token-broker/wrangler.jsonc \
    --dry-run --outdir test/integration/dist/worker/observation-failure \
    --name integration-worker-observation-failure \
    && mv test/integration/dist/worker/observation-failure/worker-observation-failure.js test/integration/dist/worker/observation-failure/worker.js
RUN node node_modules/wrangler/bin/wrangler.js deploy test/integration/worker-other-app-observation-failure.ts \
    --config workers/github-app-token-broker/wrangler.jsonc \
    --dry-run --outdir test/integration/dist/worker/other-app-observation-failure \
    --name integration-worker-other-app-observation-failure \
    && mv test/integration/dist/worker/other-app-observation-failure/worker-other-app-observation-failure.js test/integration/dist/worker/other-app-observation-failure/worker.js
