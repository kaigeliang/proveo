// Base 数据规范化导入（IMPLEMENTATION_SPEC §9.5）
//
// 一次性把 base 数据洗成与上传链路完全同构的形态：
//   1. 区分两条入库路径：商品素材 → /materials/upload（进入创作池）；
//      爆款视频 → /reference-videos/import（只存拆解，禁止流入创作）。
//   2. 标签可多源：manifest 里带的三层标签会原样透传给后端；缺哪层后端用
//      自有打标兜底。
//   3. 向量必须单源：manifest 必须声明 embeddingModel，且与后端
//      Jina CLIP 运行时模型一致；item 自带的任何 embedding 一律丢弃，强制重算。
//
// 用法：
//   API_BASE=http://127.0.0.1:5001/api \
//   CN_CLIP_MODEL=jinaai/jina-clip-v2 \
//   node scripts/normalize-materials.mjs --manifest=scripts/fixtures/base-materials.sample.json

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:5001/api';
const EXPECTED_MODEL = process.env.CN_CLIP_MODEL || 'jinaai/jina-clip-v2';

function readArg(name, fallback = '') {
  const exact = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (exact) return exact.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

async function request(pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} -> ${response.status}: ${text}`);
  }
  return data;
}

function placeholderDataUrl(kind) {
  // 1x1 png（image）/ 极简 mp4 头（video）。真实场景应替换为原始字节；
  // 此处占位是因为 base 数据来源不一致，但管线对所有 item 一视同仁。
  if (kind === 'video') {
    return 'data:video/mp4;base64,AAAAGGZ0eXBpc29tAAAAAGlzb21pc28y';
  }
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
}

async function uploadMaterial(item) {
  const body = {
    name: item.name || item.id || 'base-material',
    productId: item.productId || '',
    sourceDeclaration: item.sourceDeclaration || 'base 数据集导入（已通过规范化管线，统一向量与三层标签）',
    dataUrl: placeholderDataUrl(item.type),
    // 标签可多源：透传给后端，后端缺哪层用自有打标补
    tags: item.tags || undefined,
  };
  return request('/materials/upload', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function importReference(item) {
  return request('/reference-videos/import', {
    method: 'POST',
    body: JSON.stringify({
      videos: [
        {
          id: item.id,
          sourceUrl: item.sourceUrl,
          sourceDeclaration: item.sourceDeclaration || '公开爆款拆解来源，仅作分析参考，不混入创作。',
          licenseType: item.licenseType || 'public_reference',
          usageScope: 'analysis',
          breakdownReport: item.breakdownReport || {
            title: item.name || '爆款带货视频拆解',
            hook: item.hook || '前三秒明确痛点或利益点。',
            sellingPoints: item.sellingPoints || [],
            style: item.style || '',
          },
        },
      ],
    }),
  });
}

const manifestPath = readArg(
  'manifest',
  fileURLToPath(new URL('./fixtures/base-materials.sample.json', import.meta.url)),
);

const raw = await readFile(path.resolve(manifestPath), 'utf8');
const manifest = JSON.parse(raw);

if (!manifest.embeddingModel) {
  throw new Error('manifest.embeddingModel 必填：声明 base 数据用的向量模型版本');
}
if (manifest.embeddingModel !== EXPECTED_MODEL) {
  throw new Error(
    `embeddingModel 不一致：manifest=${manifest.embeddingModel} 当前期望=${EXPECTED_MODEL}。` +
      '全库向量必须单源；请把 base 数据重算到与运行时一致的 Jina CLIP 版本。',
  );
}

const items = Array.isArray(manifest.items) ? manifest.items : [];
const report = {
  manifest: manifestPath,
  embeddingModel: manifest.embeddingModel,
  total: items.length,
  materials: 0,
  references: 0,
  rejectedEmbeddings: 0,
  failed: [],
};

for (const item of items) {
  if (Array.isArray(item.embedding) && item.embedding.length > 0) {
    // 不同模型的向量不在同一空间，禁止透传。后端会用统一模型重算。
    report.rejectedEmbeddings += 1;
    delete item.embedding;
  }

  try {
    if (item.kind === 'reference') {
      await importReference(item);
      report.references += 1;
    } else {
      await uploadMaterial(item);
      report.materials += 1;
    }
  } catch (error) {
    report.failed.push({
      id: item.id || item.name,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log(JSON.stringify(report, null, 2));

if (report.failed.length > 0) {
  process.exitCode = 1;
}
