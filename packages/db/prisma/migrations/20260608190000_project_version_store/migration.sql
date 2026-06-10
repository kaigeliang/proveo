-- Project/conversation/version persistence for the merchant-facing P0 flow.
-- These tables keep chat history, script plans, render versions and active
-- task/run handles in Postgres so the UI is not limited to browser localStorage.

CREATE TABLE "Project" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "productId" TEXT,
  "productTitle" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "activeConversationId" TEXT,
  "activeScriptVersionId" TEXT,
  "activeRenderVersionId" TEXT,
  "activeTaskId" TEXT,
  "activeRunId" TEXT,
  "snapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Conversation" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "messages" JSONB NOT NULL,
  "activityItems" JSONB,
  "magicProgress" JSONB,
  "activeTaskId" TEXT,
  "activeRunId" TEXT,
  "activeScriptId" TEXT,
  "snapshot" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectScriptVersion" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "scriptId" TEXT,
  "sourceRunId" TEXT,
  "scriptSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProjectScriptVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectRenderVersion" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "scriptVersionId" TEXT,
  "label" TEXT NOT NULL,
  "taskId" TEXT,
  "videoId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'completed',
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProjectRenderVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Project_productId_idx" ON "Project"("productId");
CREATE INDEX "Project_status_idx" ON "Project"("status");
CREATE INDEX "Project_updatedAt_idx" ON "Project"("updatedAt");

CREATE INDEX "Conversation_projectId_idx" ON "Conversation"("projectId");
CREATE INDEX "Conversation_activeTaskId_idx" ON "Conversation"("activeTaskId");
CREATE INDEX "Conversation_activeRunId_idx" ON "Conversation"("activeRunId");
CREATE INDEX "Conversation_updatedAt_idx" ON "Conversation"("updatedAt");

CREATE INDEX "ProjectScriptVersion_projectId_idx" ON "ProjectScriptVersion"("projectId");
CREATE INDEX "ProjectScriptVersion_scriptId_idx" ON "ProjectScriptVersion"("scriptId");
CREATE INDEX "ProjectScriptVersion_sourceRunId_idx" ON "ProjectScriptVersion"("sourceRunId");
CREATE INDEX "ProjectScriptVersion_createdAt_idx" ON "ProjectScriptVersion"("createdAt");

CREATE INDEX "ProjectRenderVersion_projectId_idx" ON "ProjectRenderVersion"("projectId");
CREATE INDEX "ProjectRenderVersion_scriptVersionId_idx" ON "ProjectRenderVersion"("scriptVersionId");
CREATE INDEX "ProjectRenderVersion_taskId_idx" ON "ProjectRenderVersion"("taskId");
CREATE INDEX "ProjectRenderVersion_videoId_idx" ON "ProjectRenderVersion"("videoId");
CREATE INDEX "ProjectRenderVersion_status_idx" ON "ProjectRenderVersion"("status");
CREATE INDEX "ProjectRenderVersion_createdAt_idx" ON "ProjectRenderVersion"("createdAt");

ALTER TABLE "Conversation"
  ADD CONSTRAINT "Conversation_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectScriptVersion"
  ADD CONSTRAINT "ProjectScriptVersion_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectRenderVersion"
  ADD CONSTRAINT "ProjectRenderVersion_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectRenderVersion"
  ADD CONSTRAINT "ProjectRenderVersion_scriptVersionId_fkey"
  FOREIGN KEY ("scriptVersionId") REFERENCES "ProjectScriptVersion"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
