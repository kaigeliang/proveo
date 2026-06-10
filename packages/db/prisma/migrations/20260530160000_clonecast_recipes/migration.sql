-- CloneCast recipe persistence.
-- Recipes are analysis-only artifacts extracted from reference videos. They can
-- drive new scripts, but they do not make third-party reference media available
-- to the creative material pool.

CREATE TABLE "Recipe" (
  "id" TEXT NOT NULL,
  "sourceUrl" TEXT,
  "sourceReferenceId" TEXT,
  "sourceDeclaration" TEXT NOT NULL,
  "productId" TEXT,
  "title" TEXT NOT NULL,
  "category" TEXT,
  "durationSeconds" DOUBLE PRECISION,
  "pace" TEXT,
  "segments" JSONB NOT NULL,
  "factors" JSONB NOT NULL,
  "visual" JSONB,
  "scoring" JSONB,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecipeClone" (
  "id" TEXT NOT NULL,
  "recipeId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "scriptId" TEXT,
  "taskId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "benchmarkScore" DOUBLE PRECISION,
  "missingFactors" JSONB,
  "scoreBreakdown" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RecipeClone_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Recipe_sourceReferenceId_idx" ON "Recipe"("sourceReferenceId");
CREATE INDEX "Recipe_productId_idx" ON "Recipe"("productId");
CREATE INDEX "Recipe_category_idx" ON "Recipe"("category");
CREATE INDEX "Recipe_status_idx" ON "Recipe"("status");
CREATE INDEX "Recipe_createdAt_idx" ON "Recipe"("createdAt");

CREATE INDEX "RecipeClone_recipeId_idx" ON "RecipeClone"("recipeId");
CREATE INDEX "RecipeClone_productId_idx" ON "RecipeClone"("productId");
CREATE INDEX "RecipeClone_scriptId_idx" ON "RecipeClone"("scriptId");
CREATE INDEX "RecipeClone_taskId_idx" ON "RecipeClone"("taskId");
CREATE INDEX "RecipeClone_status_idx" ON "RecipeClone"("status");

ALTER TABLE "RecipeClone"
  ADD CONSTRAINT "RecipeClone_recipeId_fkey"
  FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
