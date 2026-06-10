-- FastMoss/VOC intelligence persistence.
-- These tables keep third-party reference intelligence as analysis-only data:
-- consumer insights, raw review signals, creative/ad performance and scene truth.

CREATE TABLE IF NOT EXISTS "ProductVocInsight" (
  "id" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'fastmoss',
  "platform" TEXT NOT NULL DEFAULT 'tiktok',
  "sourceUrl" TEXT,
  "productExternalId" TEXT,
  "productTitle" TEXT NOT NULL,
  "category" TEXT,
  "analysisWindow" TEXT,
  "analyzedCommentCount" INTEGER,
  "consumerProfile" JSONB,
  "starImpact" JSONB,
  "usageScenarios" JSONB,
  "positiveExperience" JSONB,
  "negativeExperience" JSONB,
  "purchaseMotives" JSONB,
  "unmetExpectations" JSONB,
  "summaryAdvice" TEXT,
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductVocInsight_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProductReviewInsight" (
  "id" TEXT NOT NULL,
  "vocInsightId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'fastmoss',
  "platform" TEXT NOT NULL DEFAULT 'tiktok',
  "sourceUrl" TEXT,
  "productTitle" TEXT,
  "sku" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "rating" DOUBLE PRECISION,
  "language" TEXT,
  "sentiment" TEXT,
  "reviewText" TEXT NOT NULL,
  "tags" JSONB,
  "motives" JSONB,
  "expectations" JSONB,
  "behaviors" JSONB,
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductReviewInsight_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CreativePerformance" (
  "id" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'fastmoss',
  "platform" TEXT NOT NULL DEFAULT 'tiktok',
  "sourceUrl" TEXT,
  "videoUrl" TEXT,
  "videoId" TEXT,
  "productTitle" TEXT,
  "productUrl" TEXT,
  "shopName" TEXT,
  "creatorHandle" TEXT,
  "advertiserName" TEXT,
  "country" TEXT,
  "category" TEXT,
  "adCopy" TEXT,
  "publishedAt" TIMESTAMP(3),
  "firstSeenAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3),
  "durationSeconds" DOUBLE PRECISION,
  "resolution" TEXT,
  "priceText" TEXT,
  "rankType" TEXT,
  "rank" INTEGER,
  "views" DOUBLE PRECISION,
  "impressions" DOUBLE PRECISION,
  "interactions" DOUBLE PRECISION,
  "adSpend" DOUBLE PRECISION,
  "sales" DOUBLE PRECISION,
  "salesAmount" DOUBLE PRECISION,
  "roas" DOUBLE PRECISION,
  "ctr" DOUBLE PRECISION,
  "interactionRate" DOUBLE PRECISION,
  "adDays" DOUBLE PRECISION,
  "metrics" JSONB,
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreativePerformance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VideoSceneTruth" (
  "id" TEXT NOT NULL,
  "referenceVideoId" TEXT,
  "creativePerformanceId" TEXT,
  "source" TEXT NOT NULL DEFAULT 'fastmoss',
  "videoUrl" TEXT,
  "sceneIndex" INTEGER NOT NULL,
  "startMs" INTEGER NOT NULL,
  "endMs" INTEGER NOT NULL,
  "summary" TEXT NOT NULL,
  "transcript" TEXT,
  "labels" JSONB,
  "ocrTexts" JSONB,
  "subtitlePlan" JSONB,
  "visual" JSONB,
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VideoSceneTruth_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ProductVocInsight_source_idx" ON "ProductVocInsight"("source");
CREATE INDEX IF NOT EXISTS "ProductVocInsight_platform_idx" ON "ProductVocInsight"("platform");
CREATE INDEX IF NOT EXISTS "ProductVocInsight_category_idx" ON "ProductVocInsight"("category");
CREATE INDEX IF NOT EXISTS "ProductVocInsight_productTitle_idx" ON "ProductVocInsight"("productTitle");
CREATE INDEX IF NOT EXISTS "ProductVocInsight_createdAt_idx" ON "ProductVocInsight"("createdAt");

CREATE INDEX IF NOT EXISTS "ProductReviewInsight_vocInsightId_idx" ON "ProductReviewInsight"("vocInsightId");
CREATE INDEX IF NOT EXISTS "ProductReviewInsight_source_idx" ON "ProductReviewInsight"("source");
CREATE INDEX IF NOT EXISTS "ProductReviewInsight_platform_idx" ON "ProductReviewInsight"("platform");
CREATE INDEX IF NOT EXISTS "ProductReviewInsight_productTitle_idx" ON "ProductReviewInsight"("productTitle");
CREATE INDEX IF NOT EXISTS "ProductReviewInsight_sentiment_idx" ON "ProductReviewInsight"("sentiment");
CREATE INDEX IF NOT EXISTS "ProductReviewInsight_rating_idx" ON "ProductReviewInsight"("rating");
CREATE INDEX IF NOT EXISTS "ProductReviewInsight_reviewedAt_idx" ON "ProductReviewInsight"("reviewedAt");

CREATE INDEX IF NOT EXISTS "CreativePerformance_source_idx" ON "CreativePerformance"("source");
CREATE INDEX IF NOT EXISTS "CreativePerformance_platform_idx" ON "CreativePerformance"("platform");
CREATE INDEX IF NOT EXISTS "CreativePerformance_videoId_idx" ON "CreativePerformance"("videoId");
CREATE INDEX IF NOT EXISTS "CreativePerformance_country_idx" ON "CreativePerformance"("country");
CREATE INDEX IF NOT EXISTS "CreativePerformance_category_idx" ON "CreativePerformance"("category");
CREATE INDEX IF NOT EXISTS "CreativePerformance_rankType_idx" ON "CreativePerformance"("rankType");
CREATE INDEX IF NOT EXISTS "CreativePerformance_rank_idx" ON "CreativePerformance"("rank");
CREATE INDEX IF NOT EXISTS "CreativePerformance_roas_idx" ON "CreativePerformance"("roas");
CREATE INDEX IF NOT EXISTS "CreativePerformance_sales_idx" ON "CreativePerformance"("sales");
CREATE INDEX IF NOT EXISTS "CreativePerformance_publishedAt_idx" ON "CreativePerformance"("publishedAt");

CREATE INDEX IF NOT EXISTS "VideoSceneTruth_referenceVideoId_idx" ON "VideoSceneTruth"("referenceVideoId");
CREATE INDEX IF NOT EXISTS "VideoSceneTruth_creativePerformanceId_idx" ON "VideoSceneTruth"("creativePerformanceId");
CREATE INDEX IF NOT EXISTS "VideoSceneTruth_source_idx" ON "VideoSceneTruth"("source");
CREATE INDEX IF NOT EXISTS "VideoSceneTruth_videoUrl_idx" ON "VideoSceneTruth"("videoUrl");
CREATE INDEX IF NOT EXISTS "VideoSceneTruth_startMs_idx" ON "VideoSceneTruth"("startMs");

ALTER TABLE "ProductReviewInsight"
  ADD CONSTRAINT "ProductReviewInsight_vocInsightId_fkey"
  FOREIGN KEY ("vocInsightId") REFERENCES "ProductVocInsight"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VideoSceneTruth"
  ADD CONSTRAINT "VideoSceneTruth_referenceVideoId_fkey"
  FOREIGN KEY ("referenceVideoId") REFERENCES "ReferenceVideo"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "VideoSceneTruth"
  ADD CONSTRAINT "VideoSceneTruth_creativePerformanceId_fkey"
  FOREIGN KEY ("creativePerformanceId") REFERENCES "CreativePerformance"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
