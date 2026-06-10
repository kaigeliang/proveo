CREATE TABLE IF NOT EXISTS "Task" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "progress" INTEGER NOT NULL DEFAULT 0,
  "step" TEXT NOT NULL DEFAULT 'queued',
  "error" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TaskTrace" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "step" TEXT NOT NULL,
  "progress" INTEGER NOT NULL,
  "message" TEXT NOT NULL,
  "data" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaskTrace_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TaskTrace_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Material" (
  "id" TEXT NOT NULL,
  "productId" TEXT,
  "name" TEXT,
  "type" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "sourceObjectKey" TEXT,
  "sourceDeclaration" TEXT NOT NULL,
  "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Slice" (
  "id" TEXT NOT NULL,
  "materialId" TEXT NOT NULL,
  "thumbnailUrl" TEXT NOT NULL,
  "thumbnailObjectKey" TEXT,
  "clipUrl" TEXT NOT NULL,
  "clipObjectKey" TEXT,
  "startTime" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "endTime" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "tags" JSONB NOT NULL,
  "summary" TEXT NOT NULL,
  "embedding" JSONB,
  CONSTRAINT "Slice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Slice_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "Script" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "productUrl" TEXT,
  "referenceImageUrl" TEXT,
  "materialIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "sourceMode" TEXT NOT NULL,
  "sourceRef" TEXT,
  "narrative" TEXT NOT NULL,
  "visualStyle" TEXT NOT NULL,
  "bgm" TEXT NOT NULL,
  "aspectRatio" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "constraints" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Script_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Shot" (
  "id" TEXT NOT NULL,
  "scriptId" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  "duration" INTEGER NOT NULL,
  "visualDesc" TEXT NOT NULL,
  "camera" TEXT NOT NULL,
  "narration" TEXT NOT NULL,
  "subtitle" TEXT NOT NULL,
  "materialRef" TEXT,
  "transition" TEXT,
  "factors" JSONB NOT NULL,
  "status" TEXT NOT NULL,
  "assetUrl" TEXT,
  "assetObjectKey" TEXT,
  "claimIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "evidenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  CONSTRAINT "Shot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Shot_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "ReferenceVideo" (
  "id" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "localVideoUrl" TEXT,
  "localObjectKey" TEXT,
  "sourceDeclaration" TEXT NOT NULL,
  "licenseType" TEXT,
  "usageScope" TEXT,
  "breakdownReport" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReferenceVideo_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EvidenceRecord" (
  "id" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "output" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvidenceRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VideoPassportRecord" (
  "videoId" TEXT NOT NULL,
  "scriptId" TEXT NOT NULL,
  "trustScore" DOUBLE PRECISION NOT NULL,
  "evidenceCoverage" DOUBLE PRECISION NOT NULL,
  "realMaterialRatio" DOUBLE PRECISION NOT NULL,
  "approvedClaims" INTEGER NOT NULL,
  "needsEvidenceClaims" INTEGER,
  "blockedClaims" INTEGER NOT NULL,
  "repairedClaims" INTEGER NOT NULL,
  "policyRisk" TEXT NOT NULL,
  "iterationCount" INTEGER NOT NULL,
  "evidenceBreakdown" JSONB NOT NULL,
  "generatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VideoPassportRecord_pkey" PRIMARY KEY ("videoId")
);

CREATE TABLE IF NOT EXISTS "VideoPerfRecord" (
  "id" TEXT NOT NULL,
  "scriptId" TEXT NOT NULL,
  "videoId" TEXT,
  "source" TEXT,
  "factorSnapshot" JSONB NOT NULL,
  "impressions" INTEGER NOT NULL,
  "ctr" DOUBLE PRECISION NOT NULL,
  "completionRate" DOUBLE PRECISION NOT NULL,
  "conversionRate" DOUBLE PRECISION NOT NULL,
  "gmv" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VideoPerfRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ComplianceCheckRecord" (
  "id" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "hits" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedBy" TEXT,
  "resolution" TEXT,
  CONSTRAINT "ComplianceCheckRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MessageFeedbackRecord" (
  "id" TEXT NOT NULL,
  "productId" TEXT,
  "messageId" TEXT NOT NULL,
  "reaction" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageFeedbackRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "FactorWeight" (
  "id" TEXT NOT NULL,
  "factorId" TEXT NOT NULL,
  "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "sampleSize" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FactorWeight_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "EvolutionPoint" (
  "id" TEXT NOT NULL,
  "factorId" TEXT NOT NULL,
  "factorType" TEXT NOT NULL,
  "factorValue" TEXT NOT NULL,
  "weight" DOUBLE PRECISION NOT NULL,
  "sampleSize" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EvolutionPoint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TrustLoopTrace" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "step" TEXT NOT NULL,
  "agentName" TEXT,
  "message" TEXT NOT NULL,
  "data" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrustLoopTrace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AuditResultRecord" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "scriptId" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "issues" JSONB NOT NULL,
  "metrics" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditResultRecord_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Task_status_idx" ON "Task"("status");
CREATE INDEX IF NOT EXISTS "Task_type_idx" ON "Task"("type");
CREATE INDEX IF NOT EXISTS "Task_updatedAt_idx" ON "Task"("updatedAt");
CREATE INDEX IF NOT EXISTS "TaskTrace_taskId_idx" ON "TaskTrace"("taskId");
CREATE INDEX IF NOT EXISTS "Material_productId_idx" ON "Material"("productId");
CREATE INDEX IF NOT EXISTS "Material_uploadedAt_idx" ON "Material"("uploadedAt");
CREATE INDEX IF NOT EXISTS "Slice_materialId_idx" ON "Slice"("materialId");
CREATE INDEX IF NOT EXISTS "Script_productId_idx" ON "Script"("productId");
CREATE INDEX IF NOT EXISTS "Script_updatedAt_idx" ON "Script"("updatedAt");
CREATE INDEX IF NOT EXISTS "Shot_scriptId_idx" ON "Shot"("scriptId");
CREATE INDEX IF NOT EXISTS "Shot_order_idx" ON "Shot"("order");
CREATE UNIQUE INDEX IF NOT EXISTS "EvidenceRecord_productId_key" ON "EvidenceRecord"("productId");
CREATE INDEX IF NOT EXISTS "VideoPassportRecord_scriptId_idx" ON "VideoPassportRecord"("scriptId");
CREATE INDEX IF NOT EXISTS "VideoPerfRecord_scriptId_idx" ON "VideoPerfRecord"("scriptId");
CREATE INDEX IF NOT EXISTS "VideoPerfRecord_videoId_idx" ON "VideoPerfRecord"("videoId");
CREATE INDEX IF NOT EXISTS "VideoPerfRecord_source_idx" ON "VideoPerfRecord"("source");
CREATE INDEX IF NOT EXISTS "ComplianceCheckRecord_targetType_targetId_idx" ON "ComplianceCheckRecord"("targetType", "targetId");
CREATE INDEX IF NOT EXISTS "ComplianceCheckRecord_level_idx" ON "ComplianceCheckRecord"("level");
CREATE INDEX IF NOT EXISTS "MessageFeedbackRecord_productId_idx" ON "MessageFeedbackRecord"("productId");
CREATE INDEX IF NOT EXISTS "MessageFeedbackRecord_messageId_idx" ON "MessageFeedbackRecord"("messageId");
CREATE UNIQUE INDEX IF NOT EXISTS "FactorWeight_factorId_key" ON "FactorWeight"("factorId");
CREATE INDEX IF NOT EXISTS "FactorWeight_factorId_idx" ON "FactorWeight"("factorId");
CREATE INDEX IF NOT EXISTS "EvolutionPoint_factorId_idx" ON "EvolutionPoint"("factorId");
CREATE INDEX IF NOT EXISTS "EvolutionPoint_updatedAt_idx" ON "EvolutionPoint"("updatedAt");
CREATE INDEX IF NOT EXISTS "TrustLoopTrace_taskId_idx" ON "TrustLoopTrace"("taskId");
CREATE UNIQUE INDEX IF NOT EXISTS "AuditResultRecord_taskId_key" ON "AuditResultRecord"("taskId");
CREATE INDEX IF NOT EXISTS "AuditResultRecord_scriptId_idx" ON "AuditResultRecord"("scriptId");
