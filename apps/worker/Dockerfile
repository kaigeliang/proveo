# bookworm-slim(glibc) 而非 alpine(musl)：onnxruntime-node 需要 glibc，否则 jina-clip 加载崩溃
FROM node:20-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg procps && rm -rf /var/lib/apt/lists/*

# 依赖安装阶段
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
COPY packages/queue/package.json ./packages/queue/
COPY packages/shared/package.json ./packages/shared/
COPY packages/storage/package.json ./packages/storage/
COPY packages/trustloop/package.json ./packages/trustloop/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
RUN npm ci --workspace=apps/worker --workspace=packages/db --workspace=packages/queue --workspace=packages/storage --workspace=packages/shared --workspace=packages/trustloop --workspace=packages/agent-runtime

# 构建阶段
FROM deps AS builder
COPY packages/ ./packages/
COPY apps/worker/ ./apps/worker/
COPY tsconfig.json ./
# Prisma 客户端必须在构建 packages/db 之前生成，否则 tsc 撞 Prisma 类型缺失（InputJsonValue 等）
RUN npx prisma generate --schema=packages/db/prisma/schema.prisma
RUN npm run build --workspace=packages/shared || true
RUN npm run build --workspace=packages/db
RUN npm run build --workspace=packages/queue || true
RUN npm run build --workspace=packages/storage || true
RUN npm run build --workspace=packages/trustloop
RUN npm run build --workspace=packages/agent-runtime
RUN npm run build --workspace=apps/worker

# 运行阶段
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/apps/worker/package.json ./apps/worker/package.json
COPY packages/db/prisma ./packages/db/prisma/

RUN mkdir -p /app/tmp/object-storage

HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD pgrep -f "node.*apps/worker" > /dev/null || exit 1

CMD ["node", "apps/worker/dist/apps/worker/src/index.js"]
