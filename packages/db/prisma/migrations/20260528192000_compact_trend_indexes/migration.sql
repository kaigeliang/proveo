-- Compact trend/retrieval indexes.
-- JSONB GIN keeps tag/category filters viable without adding pgvector as a hard dependency.

CREATE INDEX IF NOT EXISTS "TrendItem_tags_gin_idx" ON "TrendItem" USING GIN ("tags");
CREATE INDEX IF NOT EXISTS "TrendItem_metrics_gin_idx" ON "TrendItem" USING GIN ("metrics");
CREATE INDEX IF NOT EXISTS "TrendItem_sourceId_fetchedAt_idx" ON "TrendItem"("sourceId", "fetchedAt" DESC);
CREATE INDEX IF NOT EXISTS "EmbeddingVector_ownerType_updatedAt_idx" ON "EmbeddingVector"("ownerType", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "EmbeddingVector_ownerType_model_idx" ON "EmbeddingVector"("ownerType", "embeddingModel");
CREATE INDEX IF NOT EXISTS "RetrievalJob_source_updatedAt_idx" ON "RetrievalJob"("source", "updatedAt" DESC);
