// 从 Postgres 的 EmbeddingVector 表重建 Qdrant 检索索引（恢复部署/clone 后用）。
// 用法：node --env-file=.env scripts/rebuild-qdrant-from-db.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = require(path.join(root, 'packages/db/dist/index.js'));

const Q = process.env.QDRANT_URL || 'http://127.0.0.1:6333';
const COLLECTIONS = {
  reference: 'aigc_reference_vectors',
  slice: 'aigc_video_clip_vectors',
  material: 'aigc_video_clip_vectors',
};

async function main() {
  const rows = await db.getPrisma().embeddingVector.findMany({
    select: { ownerType: true, ownerId: true, vector: true, metadata: true, embeddingModel: true },
  });
  console.log('EmbeddingVector 行数:', rows.length);
  const byCollection = new Map();
  for (const r of rows) {
    const col = COLLECTIONS[r.ownerType] || COLLECTIONS.slice;
    if (!byCollection.has(col)) byCollection.set(col, []);
    byCollection.get(col).push(r);
  }
  for (const [col, items] of byCollection) {
    await fetch(`${Q}/collections/${col}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vectors: { size: 1024, distance: 'Cosine' } }),
    });
    let id = 1;
    for (let i = 0; i < items.length; i += 100) {
      const points = items.slice(i, i + 100).map((r) => ({
        id: id++,
        vector: Array.isArray(r.vector) ? r.vector : r.vector?.data || [],
        payload: { ownerType: r.ownerType, ownerId: r.ownerId, embeddingModel: r.embeddingModel, ...(r.metadata || {}) },
      })).filter((p) => p.vector.length === 1024);
      await fetch(`${Q}/collections/${col}/points?wait=true`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points }),
      });
    }
    const info = await (await fetch(`${Q}/collections/${col}`)).json();
    console.log(`${col}: ${info.result?.points_count} 点`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
