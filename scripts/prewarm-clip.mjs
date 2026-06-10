#!/usr/bin/env node
import path from 'node:path';
import { AutoModel, AutoProcessor, env } from '@huggingface/transformers';

const modelId = process.env.CN_CLIP_MODEL || 'jinaai/jina-clip-v2';
const cacheDir = path.join(process.cwd(), '.cache', 'hf');

env.cacheDir = cacheDir;

console.log(`[clip] cacheDir=${cacheDir}`);
console.log(`[clip] downloading ${modelId} model/processor assets if missing...`);

await Promise.all([
  AutoModel.from_pretrained(modelId, { dtype: 'q8' }),
  AutoProcessor.from_pretrained(modelId),
]);

console.log(`[clip] ready: ${modelId}`);
