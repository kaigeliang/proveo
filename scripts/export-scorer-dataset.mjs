#!/usr/bin/env node
// 从 DB 导出爆款 scorer 训练/消融数据集（embedding + 标签 + Qwen 因子 + 达人）。
// 数据本身不提交（落 tmp/，已 gitignore）；本脚本提交以保证可复现。
//
// 用法：
//   npm run ml:export-dataset                      # 默认输出 tmp/ml-ablation/dataset.jsonl
//   node scripts/export-scorer-dataset.mjs --out=tmp/x.jsonl --model=jinaai/jina-clip-v2
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 最小 .env 读取，避免引入 dotenv 依赖；已存在的环境变量优先。
if (!process.env.DATABASE_URL) {
  try {
    for (const line of fs.readFileSync(path.join(repoRoot, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // CI/容器可直接提供 DATABASE_URL
  }
}

function readArg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const embeddingModel = readArg('model', 'jinaai/jina-clip-v2');
const outPath = path.resolve(repoRoot, readArg('out', 'tmp/ml-ablation/dataset.jsonl'));

const prisma = new PrismaClient();

const rows = await prisma.embeddingVector.findMany({
  where: { embeddingModel },
  select: { vector: true, metadata: true },
});

fs.mkdirSync(path.dirname(outPath), { recursive: true });
const out = fs.createWriteStream(outPath);
let n = 0;
let withFactors = 0;
for (const row of rows) {
  const meta = row.metadata || {};
  const vector = row.vector;
  if (!Array.isArray(vector) || vector.length !== 1024) continue;
  const factorIds = Array.isArray(meta.qwenTruth?.factorIds)
    ? meta.qwenTruth.factorIds.filter((x) => typeof x === 'string')
    : [];
  if (factorIds.length) withFactors += 1;
  out.write(
    `${JSON.stringify({
      embedding: vector,
      benchmarkScore: Number(meta.benchmarkScore) || 0,
      organicWinner: meta.organicWinner === true ? 1 : 0,
      lowFollowerWinner: meta.lowFollowerWinner === true ? 1 : 0,
      durationSeconds: Number(meta.durationSeconds) || 0,
      category: meta.category || '',
      creatorHandle: meta.creatorHandle || '',
      qwenFactorIds: factorIds,
    })}\n`,
  );
  n += 1;
}
out.end();
await new Promise((resolve) => out.on('finish', resolve));
await prisma.$disconnect();
console.log(`exported rows=${n} withQwenFactors=${withFactors} → ${path.relative(repoRoot, outPath)}`);
