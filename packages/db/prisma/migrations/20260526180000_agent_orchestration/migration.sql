CREATE TABLE IF NOT EXISTS "AgentRun" (
  "id" TEXT NOT NULL,
  "taskId" TEXT,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "graphVersion" TEXT NOT NULL,
  "productId" TEXT,
  "scriptId" TEXT,
  "videoId" TEXT,
  "input" JSONB NOT NULL,
  "output" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AgentStep" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "agentName" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "inputRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "outputRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "decision" TEXT,
  "reason" TEXT,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "AgentArtifact" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "stepId" TEXT,
  "type" TEXT NOT NULL,
  "content" JSONB,
  "objectKey" TEXT,
  "contentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentArtifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentArtifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AgentArtifact_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "AgentStep"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "AgentToolCall" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "stepId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "input" JSONB,
  "output" JSONB,
  "latencyMs" INTEGER,
  "costEstimate" DOUBLE PRECISION,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentToolCall_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentToolCall_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "AgentStep"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "AgentRun_status_idx" ON "AgentRun"("status");
CREATE INDEX IF NOT EXISTS "AgentRun_kind_idx" ON "AgentRun"("kind");
CREATE INDEX IF NOT EXISTS "AgentRun_productId_idx" ON "AgentRun"("productId");
CREATE INDEX IF NOT EXISTS "AgentRun_scriptId_idx" ON "AgentRun"("scriptId");
CREATE INDEX IF NOT EXISTS "AgentRun_updatedAt_idx" ON "AgentRun"("updatedAt");

CREATE INDEX IF NOT EXISTS "AgentStep_runId_idx" ON "AgentStep"("runId");
CREATE INDEX IF NOT EXISTS "AgentStep_nodeId_idx" ON "AgentStep"("nodeId");
CREATE INDEX IF NOT EXISTS "AgentStep_agentName_idx" ON "AgentStep"("agentName");
CREATE INDEX IF NOT EXISTS "AgentStep_status_idx" ON "AgentStep"("status");

CREATE INDEX IF NOT EXISTS "AgentArtifact_runId_idx" ON "AgentArtifact"("runId");
CREATE INDEX IF NOT EXISTS "AgentArtifact_stepId_idx" ON "AgentArtifact"("stepId");
CREATE INDEX IF NOT EXISTS "AgentArtifact_type_idx" ON "AgentArtifact"("type");

CREATE INDEX IF NOT EXISTS "AgentToolCall_runId_idx" ON "AgentToolCall"("runId");
CREATE INDEX IF NOT EXISTS "AgentToolCall_stepId_idx" ON "AgentToolCall"("stepId");
CREATE INDEX IF NOT EXISTS "AgentToolCall_toolName_idx" ON "AgentToolCall"("toolName");
