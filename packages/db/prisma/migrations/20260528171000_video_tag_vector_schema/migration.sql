CREATE TABLE IF NOT EXISTS "VideoAsset" (
  "id" TEXT NOT NULL,
  "productId" TEXT,
  "sourceUrl" TEXT NOT NULL,
  "sourceObjectKey" TEXT,
  "sourceDeclaration" TEXT NOT NULL,
  "title" TEXT,
  "platform" TEXT,
  "durationMs" INTEGER,
  "contentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VideoAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VideoSegment" (
  "id" TEXT NOT NULL,
  "videoId" TEXT NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "transcript" TEXT,
  "visualSummary" TEXT NOT NULL,
  "thumbnailUrl" TEXT,
  "clipUrl" TEXT,
  "contentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VideoSegment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VideoSegment_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "VideoAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "VideoTag" (
  "id" TEXT NOT NULL,
  "namespace" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "description" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VideoTag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VideoTagAssignment" (
  "segmentId" TEXT NOT NULL,
  "tagId" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "source" TEXT NOT NULL,
  "modelVersion" TEXT,
  "evidence" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VideoTagAssignment_pkey" PRIMARY KEY ("segmentId", "tagId", "source"),
  CONSTRAINT "VideoTagAssignment_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "VideoSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "VideoTagAssignment_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "VideoTag"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "EmbeddingVector" (
  "id" TEXT NOT NULL,
  "ownerType" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "segmentId" TEXT,
  "embeddingModel" TEXT NOT NULL,
  "dims" INTEGER NOT NULL,
  "vector" JSONB,
  "quantizedObject" TEXT,
  "vectorHash" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmbeddingVector_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmbeddingVector_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "VideoSegment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "EmbeddingVersion" (
  "id" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "dims" INTEGER NOT NULL,
  "quantization" TEXT NOT NULL,
  "vectorStore" TEXT NOT NULL,
  "promptPolicy" JSONB,
  "isActive" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastRebuiltAt" TIMESTAMP(3),
  CONSTRAINT "EmbeddingVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RetrievalJob" (
  "id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "cursor" TEXT,
  "filters" JSONB,
  "stats" JSONB,
  "error" TEXT,
  "scheduledFor" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RetrievalJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TrendSource" (
  "id" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "url" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "refreshCron" TEXT,
  "config" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrendSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TrendItem" (
  "id" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "url" TEXT,
  "tags" JSONB NOT NULL,
  "metrics" JSONB,
  "embeddingId" TEXT,
  "fetchedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TrendItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrendItem_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TrendSource"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "VideoAsset_productId_idx" ON "VideoAsset"("productId");
CREATE INDEX IF NOT EXISTS "VideoAsset_platform_idx" ON "VideoAsset"("platform");
CREATE INDEX IF NOT EXISTS "VideoAsset_contentHash_idx" ON "VideoAsset"("contentHash");
CREATE INDEX IF NOT EXISTS "VideoAsset_updatedAt_idx" ON "VideoAsset"("updatedAt");

CREATE INDEX IF NOT EXISTS "VideoSegment_videoId_idx" ON "VideoSegment"("videoId");
CREATE INDEX IF NOT EXISTS "VideoSegment_contentHash_idx" ON "VideoSegment"("contentHash");
CREATE INDEX IF NOT EXISTS "VideoSegment_updatedAt_idx" ON "VideoSegment"("updatedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "VideoTag_namespace_normalizedName_key" ON "VideoTag"("namespace", "normalizedName");
CREATE INDEX IF NOT EXISTS "VideoTag_namespace_idx" ON "VideoTag"("namespace");
CREATE INDEX IF NOT EXISTS "VideoTag_normalizedName_idx" ON "VideoTag"("normalizedName");

CREATE INDEX IF NOT EXISTS "VideoTagAssignment_tagId_idx" ON "VideoTagAssignment"("tagId");
CREATE INDEX IF NOT EXISTS "VideoTagAssignment_source_idx" ON "VideoTagAssignment"("source");
CREATE INDEX IF NOT EXISTS "VideoTagAssignment_confidence_idx" ON "VideoTagAssignment"("confidence");

CREATE UNIQUE INDEX IF NOT EXISTS "EmbeddingVector_ownerType_ownerId_embeddingModel_key" ON "EmbeddingVector"("ownerType", "ownerId", "embeddingModel");
CREATE INDEX IF NOT EXISTS "EmbeddingVector_segmentId_idx" ON "EmbeddingVector"("segmentId");
CREATE INDEX IF NOT EXISTS "EmbeddingVector_embeddingModel_idx" ON "EmbeddingVector"("embeddingModel");
CREATE INDEX IF NOT EXISTS "EmbeddingVector_vectorHash_idx" ON "EmbeddingVector"("vectorHash");

CREATE INDEX IF NOT EXISTS "EmbeddingVersion_isActive_idx" ON "EmbeddingVersion"("isActive");
CREATE INDEX IF NOT EXISTS "EmbeddingVersion_modelId_idx" ON "EmbeddingVersion"("modelId");

CREATE INDEX IF NOT EXISTS "RetrievalJob_source_idx" ON "RetrievalJob"("source");
CREATE INDEX IF NOT EXISTS "RetrievalJob_status_idx" ON "RetrievalJob"("status");
CREATE INDEX IF NOT EXISTS "RetrievalJob_scheduledFor_idx" ON "RetrievalJob"("scheduledFor");

CREATE INDEX IF NOT EXISTS "TrendSource_platform_idx" ON "TrendSource"("platform");
CREATE INDEX IF NOT EXISTS "TrendSource_enabled_idx" ON "TrendSource"("enabled");
CREATE UNIQUE INDEX IF NOT EXISTS "TrendItem_sourceId_externalId_key" ON "TrendItem"("sourceId", "externalId");
CREATE INDEX IF NOT EXISTS "TrendItem_sourceId_idx" ON "TrendItem"("sourceId");
CREATE INDEX IF NOT EXISTS "TrendItem_fetchedAt_idx" ON "TrendItem"("fetchedAt");
