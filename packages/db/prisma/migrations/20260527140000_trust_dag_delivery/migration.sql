-- TrustDAG stores immutable content-addressed payloads plus mutable validity state.
CREATE TABLE "TrustNode" (
    "id" TEXT NOT NULL,
    "nodeType" TEXT NOT NULL,
    "parentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contentHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "staleAt" TIMESTAMP(3),
    "staleReason" TEXT,
    "invalidatedById" TEXT,
    "runId" TEXT,
    "taskId" TEXT,
    "productId" TEXT,
    "scriptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrustNode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TrustEdge" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "edgeType" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustEdge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ApiIdempotencyRecord" (
    "key" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "statusCode" INTEGER,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiIdempotencyRecord_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "TournamentRun" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "baseScriptId" TEXT,
    "status" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "maxGens" INTEGER NOT NULL DEFAULT 5,
    "populationN" INTEGER NOT NULL DEFAULT 10,
    "winnerId" TEXT,
    "config" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TournamentRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TournamentVariant" (
    "id" TEXT NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "parentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "genes" JSONB NOT NULL,
    "scriptSnapshot" JSONB NOT NULL,
    "llmScore" DOUBLE PRECISION,
    "ctrScore" DOUBLE PRECISION,
    "compositeScore" DOUBLE PRECISION,
    "scoreBreakdown" JSONB,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TournamentVariant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrustNode_contentHash_key" ON "TrustNode"("contentHash");
CREATE INDEX "TrustNode_nodeType_idx" ON "TrustNode"("nodeType");
CREATE INDEX "TrustNode_status_idx" ON "TrustNode"("status");
CREATE INDEX "TrustNode_runId_idx" ON "TrustNode"("runId");
CREATE INDEX "TrustNode_productId_idx" ON "TrustNode"("productId");
CREATE INDEX "TrustNode_scriptId_idx" ON "TrustNode"("scriptId");
CREATE INDEX "TrustNode_taskId_idx" ON "TrustNode"("taskId");
CREATE UNIQUE INDEX "TrustEdge_sourceId_targetId_edgeType_key" ON "TrustEdge"("sourceId", "targetId", "edgeType");
CREATE INDEX "TrustEdge_sourceId_idx" ON "TrustEdge"("sourceId");
CREATE INDEX "TrustEdge_targetId_idx" ON "TrustEdge"("targetId");
CREATE INDEX "TrustEdge_edgeType_idx" ON "TrustEdge"("edgeType");
CREATE INDEX "ApiIdempotencyRecord_route_idx" ON "ApiIdempotencyRecord"("route");
CREATE INDEX "ApiIdempotencyRecord_expiresAt_idx" ON "ApiIdempotencyRecord"("expiresAt");
CREATE INDEX "TournamentRun_productId_idx" ON "TournamentRun"("productId");
CREATE INDEX "TournamentRun_status_idx" ON "TournamentRun"("status");
CREATE INDEX "TournamentVariant_tournamentId_idx" ON "TournamentVariant"("tournamentId");
CREATE INDEX "TournamentVariant_generation_idx" ON "TournamentVariant"("generation");
CREATE INDEX "TournamentVariant_compositeScore_idx" ON "TournamentVariant"("compositeScore");
CREATE INDEX "TournamentVariant_status_idx" ON "TournamentVariant"("status");

ALTER TABLE "TrustEdge"
ADD CONSTRAINT "TrustEdge_sourceId_fkey"
FOREIGN KEY ("sourceId") REFERENCES "TrustNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrustEdge"
ADD CONSTRAINT "TrustEdge_targetId_fkey"
FOREIGN KEY ("targetId") REFERENCES "TrustNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TournamentVariant"
ADD CONSTRAINT "TournamentVariant_tournamentId_fkey"
FOREIGN KEY ("tournamentId") REFERENCES "TournamentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
