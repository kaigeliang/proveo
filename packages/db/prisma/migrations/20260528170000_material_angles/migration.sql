CREATE TABLE IF NOT EXISTS "MaterialAngle" (
  "id" TEXT NOT NULL,
  "materialId" TEXT NOT NULL,
  "productId" TEXT,
  "view" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "imageUrl" TEXT NOT NULL,
  "referenceImageUrl" TEXT NOT NULL,
  "previewUrl" TEXT,
  "sourceImageUrl" TEXT NOT NULL,
  "promptHint" TEXT NOT NULL,
  "pose" JSONB,
  "provider" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MaterialAngle_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MaterialAngle_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "MaterialAngle_materialId_key_key" ON "MaterialAngle"("materialId", "key");
CREATE INDEX IF NOT EXISTS "MaterialAngle_materialId_idx" ON "MaterialAngle"("materialId");
CREATE INDEX IF NOT EXISTS "MaterialAngle_productId_idx" ON "MaterialAngle"("productId");
CREATE INDEX IF NOT EXISTS "MaterialAngle_provider_idx" ON "MaterialAngle"("provider");
CREATE INDEX IF NOT EXISTS "MaterialAngle_status_idx" ON "MaterialAngle"("status");
CREATE INDEX IF NOT EXISTS "MaterialAngle_createdAt_idx" ON "MaterialAngle"("createdAt");
