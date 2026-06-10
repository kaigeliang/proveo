// Recompute demo/runtime slice vectors with the real cached Jina CLIP model.
//
// Usage:
//   npm run build --prefix apps/api
//   node scripts/recompute-slice-embeddings.mjs

import { createRequire } from 'node:module';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const apiDir = path.join(repoRoot, 'apps/api');
const storeFile = path.join(apiDir, 'data/spec-runtime.json');
const clipModulePath = path.join(apiDir, 'dist/apps/api/src/lib/clip.js');

function vectorNorm(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function sliceText(slice) {
  const tags = slice.tags && typeof slice.tags === 'object' ? Object.values(slice.tags).flat().join(' ') : '';
  return `${slice.summary || ''} ${tags}`.replace(/\s+/g, ' ').trim();
}

process.chdir(apiDir);
const require = createRequire(import.meta.url);
const { embedText, CLIP_MODEL_ID, EMBEDDING_DIMS } = require(clipModulePath);

const store = JSON.parse(await readFile(storeFile, 'utf8'));
const slices = Array.isArray(store.slices) ? store.slices : [];
if (!slices.length) throw new Error(`No slices found in ${storeFile}`);

const backupFile = `${storeFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await copyFile(storeFile, backupFile);

let recomputed = 0;
for (const slice of slices) {
  const text = sliceText(slice) || slice.id;
  const embedding = await embedText(text);
  const norm = vectorNorm(embedding);
  if (embedding.length !== EMBEDDING_DIMS || norm < 0.95 || norm > 1.05) {
    throw new Error(
      `Embedding for ${slice.id} is not a real normalized ${CLIP_MODEL_ID} vector: dims=${embedding.length}, norm=${norm}`,
    );
  }
  slice.embedding = embedding.map((value) => Number(value.toFixed(8)));
  slice.embeddingModel = CLIP_MODEL_ID;
  recomputed += 1;
}

store.embeddingModel = CLIP_MODEL_ID;
store.embeddingDims = EMBEDDING_DIMS;
store.embeddingUpdatedAt = new Date().toISOString();

await writeFile(storeFile, `${JSON.stringify(store, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      storeFile,
      backupFile,
      embeddingModel: CLIP_MODEL_ID,
      embeddingDims: EMBEDDING_DIMS,
      recomputed,
    },
    null,
    2,
  ),
);
