# bookworm-slim(glibc) 而非 alpine(musl)：onnxruntime-node 需要 glibc，否则 jina-clip 加载崩溃
FROM node:20-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg wget && rm -rf /var/lib/apt/lists/*

# 依赖安装阶段
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
COPY packages/queue/package.json ./packages/queue/
COPY packages/shared/package.json ./packages/shared/
COPY packages/storage/package.json ./packages/storage/
COPY packages/agent-runtime/package.json ./packages/agent-runtime/
COPY packages/trustloop/package.json ./packages/trustloop/
RUN npm ci --workspace=apps/api --workspace=packages/db --workspace=packages/queue --workspace=packages/storage --workspace=packages/shared --workspace=packages/agent-runtime --workspace=packages/trustloop

# 构建阶段
FROM deps AS builder
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/
COPY tsconfig.json ./
# Prisma 客户端必须在构建 packages/db 之前生成，否则 tsc 撞 Prisma 类型缺失（InputJsonValue 等）
RUN npx prisma generate --schema=packages/db/prisma/schema.prisma
RUN npm run build --workspace=packages/shared || true
RUN npm run build --workspace=packages/db
RUN npm run build --workspace=packages/queue || true
RUN npm run build --workspace=packages/storage || true
RUN npm run build --workspace=packages/agent-runtime
RUN npm run build --workspace=packages/trustloop
RUN npm run build --workspace=apps/api

# 运行阶段
FROM base AS runner
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY packages/db/prisma ./packages/db/prisma/

RUN mkdir -p /app/apps/api/public/uploads /app/apps/api/public/generated /app/tmp/object-storage

EXPOSE 5001

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:5001/api/health | grep '"ok":true' || exit 1

CMD ["node", "apps/api/dist/apps/api/src/index.js"]
