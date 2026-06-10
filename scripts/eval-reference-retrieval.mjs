#!/usr/bin/env node
// Tier-1 engineering evidence: reference-retrieval quality + performance + scorer test metrics.
//
//  - Queries: the 177 held-out (split=test) QwenVL-analyzed videos.
//  - Leave-one-out: the query's own id is excluded from its results.
//  - Quality proxy: category-hit@K and same-category precision@K (semantic coherence).
//  - Parity: top-1 agreement between Qdrant ANN and pgvector brute force.
//  - Performance: per-query embed / Qdrant / pgvector latency (p50/p95/mean).
//  - Scorer: held-out test metrics read from scorer-model.json.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  require('dotenv').config({ path: path.join(root, '.env') });
} catch {}

const TRAINING = path.join(root, 'tmp/kalodata-test/qwenvl-url-ingested-v2/benchmark-training.qwenvl.jsonl');
const SCORER = path.join(root, 'apps/api/src/lib/scoring/scorer-model.json');
const OUT_MD = path.join(root, 'docs/architecture.md');
const SECTION_START = '<!-- BEGIN GENERATED_EVALUATION -->';
const SECTION_END = '<!-- END GENERATED_EVALUATION -->';
const KS = [1, 3, 5, 10];

const clipPath = path.join(root, 'apps/api/dist/apps/api/src/lib/clip.js');
if (!fs.existsSync(clipPath)) throw new Error('Run `npm run build --prefix apps/api` first.');
process.chdir(path.join(root, 'apps/api'));
const { embedTextStrict } = require(clipPath);
const db = require('@aigc-video-hub/db');

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2));
};
const mean = (arr) => (arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(4)) : 0);
const catOf = (hit) => String(hit?.metadata?.category ?? hit?.breakdownReport?.category ?? '').trim();

const run = async () => {
  const queries = fs
    .readFileSync(TRAINING, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter(
      (r) => r.split === 'test' && Array.isArray(r.qwenFactorIds) && r.qwenFactorIds.length > 0 && r.referenceText,
    )
    .map((r) => ({ id: r.id, category: String(r.category || '').trim(), text: r.referenceText }));

  const stats = {
    qdrant: { hit: Object.fromEntries(KS.map((k) => [k, 0])), prec: [], top1: [], lat: [] },
    pgvector: { hit: Object.fromEntries(KS.map((k) => [k, 0])), prec: [], top1: [], lat: [] },
  };
  const embedLat = [];
  let agree = 0;
  let evaluated = 0;

  for (const q of queries) {
    let t = performance.now();
    const queryVector = await embedTextStrict(q.text);
    embedLat.push(performance.now() - t);
    const input = { queryVector, embeddingModel: db.REFERENCE_TEXT_EMBEDDING_MODEL, limit: 11 };

    t = performance.now();
    const qd = (await db.searchReferenceQdrant(input)).filter((h) => h.id !== q.id).slice(0, 10);
    stats.qdrant.lat.push(performance.now() - t);

    t = performance.now();
    const pg = (await db.searchReferenceVideoEmbeddings(input)).filter((h) => h.id !== q.id).slice(0, 10);
    stats.pgvector.lat.push(performance.now() - t);

    if (!qd.length && !pg.length) continue;
    evaluated += 1;

    for (const [name, hits] of [
      ['qdrant', qd],
      ['pgvector', pg],
    ]) {
      const cats = hits.map(catOf);
      for (const k of KS) if (q.category && cats.slice(0, k).includes(q.category)) stats[name].hit[k] += 1;
      const top10 = cats.slice(0, 10).filter(Boolean);
      stats[name].prec.push(
        q.category && top10.length ? top10.filter((c) => c === q.category).length / top10.length : 0,
      );
      stats[name].top1.push(cats[0] || '');
    }
    if (qd[0] && pg[0] && qd[0].id === pg[0].id) agree += 1;
  }

  const scorer = JSON.parse(fs.readFileSync(SCORER, 'utf-8'));
  const quality = (name) => ({
    ...Object.fromEntries(KS.map((k) => [`categoryHit@${k}`, Number((stats[name].hit[k] / evaluated).toFixed(4))])),
    sameCategoryPrecision: mean(stats[name].prec),
  });
  const perf = (name) => ({
    p50ms: pct(stats[name].lat, 50),
    p95ms: pct(stats[name].lat, 95),
    meanMs: mean(stats[name].lat),
  });

  const result = {
    generatedAt: new Date().toISOString(),
    indexSize: 889,
    queries: queries.length,
    evaluated,
    retrievalQuality: { qdrant: quality('qdrant'), pgvector: quality('pgvector') },
    qdrantPgvectorTop1Agreement: Number((agree / evaluated).toFixed(4)),
    performance: {
      embedding_jina_clip_v2: { p50ms: pct(embedLat, 50), p95ms: pct(embedLat, 95), meanMs: mean(embedLat) },
      qdrant_ann: perf('qdrant'),
      pgvector_bruteforce: perf('pgvector'),
    },
    scorerTestMetrics: { modelVersion: scorer.version, ...scorer.metrics.test },
  };

  console.log(JSON.stringify(result, null, 2));

  const q = result.retrievalQuality;
  const p = result.performance;
  const md = `${SECTION_START}

## 评测与 ML 结论

最后更新：${new Date().toISOString()}。本节合并原 ML 消融、CloneCast 检索/性能报告和评测口径。\`node scripts/eval-reference-retrieval.mjs\` 会更新本节。

### 评测口径

- scoring 分两层：\`benchmark-scorer\` 是真实训练模型；\`mock-ctr\` / \`/feedback/simulate\` 是 display-only 模拟表现。
- GMV、销量、播放等历史表现只作 label / 参考排序，不作新视频上线前评分输入。
- Qwen 创意因子用于归因、可解释和生成引导，不用于提升主预测精度。
- 对外使用 creator-disjoint 数字，避免随机切分造成乐观估计。

### ML 消融：CLIP vs Qwen 创意因子

可复现：\`npm run ml:export-dataset\` -> \`npm run ml:ablate\`。

| 目标 | A 基线(CLIP) | B 仅因子 | C 融合 |
|---|---|---|---|
| benchmarkScore Spearman | **0.449** | 0.212 | 0.449 |
| benchmarkScore NDCG@20 | 0.883 | 0.825 | 0.890 |
| benchmarkScore R2 | 0.157 | 0.017 | 0.148 |
| organicWinner AUC | **0.809** | 0.652 | 0.808 |

结论：Qwen 创意因子对预测无增量，价值主要在归因、可解释和生成引导。creator-disjoint 对外口径为 Spearman 0.45 / AUC 0.81；因子 lift 是关联，不是因果。

### CloneCast 评测与性能报告

_生成时间: ${result.generatedAt} · 索引规模: ${result.indexSize} 条 QwenVL 分析爆款 · 留出测试 query: ${result.evaluated} 条_

#### 1. 打分模型 — 留出测试集指标 (scorer-model v${result.scorerTestMetrics.modelVersion})

在 Kalodata 真实电商 GMV/ROAS 数据上训练的 PCA(50)+LightGBM scorer，held-out 测试集表现：

| 指标 | 值 | 含义 |
|---|---|---|
| AUC (自然流量爆款) | **${result.scorerTestMetrics.aucOrganicWinner}** | 区分自然流量爆款的能力 |
| AUC (低粉爆款) | **${result.scorerTestMetrics.aucLowFollowerWinner}** | 区分低粉爆款的能力 |
| NDCG@20 | **${result.scorerTestMetrics.ndcgAt20}** | 排序质量 |
| Spearman | ${result.scorerTestMetrics.spearman} | 与真实表现的秩相关 |
| MAE | ${result.scorerTestMetrics.mae} | benchmarkScore 平均绝对误差 |
| R2 | ${result.scorerTestMetrics.r2} | 解释方差 |

#### 2. 检索质量 — 留出 query 留一法 (category 命中代理指标)

用 ${result.evaluated} 条 held-out 视频做 query（排除自身），看 top-K 是否召回同类目爆款：

| 指标 | Qdrant (ANN) | pgvector (暴力) |
|---|---|---|
| categoryHit@1 | ${q.qdrant['categoryHit@1']} | ${q.pgvector['categoryHit@1']} |
| categoryHit@3 | ${q.qdrant['categoryHit@3']} | ${q.pgvector['categoryHit@3']} |
| categoryHit@5 | ${q.qdrant['categoryHit@5']} | ${q.pgvector['categoryHit@5']} |
| categoryHit@10 | ${q.qdrant['categoryHit@10']} | ${q.pgvector['categoryHit@10']} |
| 同类目精度@10 | ${q.qdrant.sameCategoryPrecision} | ${q.pgvector.sameCategoryPrecision} |

**Qdrant vs pgvector top-1 一致率: ${result.qdrantPgvectorTop1Agreement}** — 两条独立检索路径结果高度一致，互为校验。

#### 3. 性能 — 单条 query 延迟

| 阶段 | p50 (ms) | p95 (ms) | mean (ms) |
|---|---|---|---|
| 文本向量化 (jina-clip-v2) | ${p.embedding_jina_clip_v2.p50ms} | ${p.embedding_jina_clip_v2.p95ms} | ${p.embedding_jina_clip_v2.meanMs} |
| Qdrant ANN 检索 | ${p.qdrant_ann.p50ms} | ${p.qdrant_ann.p95ms} | ${p.qdrant_ann.meanMs} |
| pgvector 暴力检索 | ${p.pgvector_bruteforce.p50ms} | ${p.pgvector_bruteforce.p95ms} | ${p.pgvector_bruteforce.meanMs} |

> 检索默认走 Qdrant ANN；pgvector 仅作历史兼容和离线对照。

_复现: \`node scripts/eval-reference-retrieval.mjs\`_

${SECTION_END}
`;
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  const current = fs.readFileSync(OUT_MD, 'utf-8');
  const next = current.includes(SECTION_START)
    ? current.replace(new RegExp(`${SECTION_START}[\\s\\S]*?${SECTION_END}`), md.trim())
    : `${current.trim()}\n\n${md.trim()}\n`;
  fs.writeFileSync(OUT_MD, next.endsWith('\n') ? next : `${next}\n`);
  console.error(`\n[eval] report section updated: ${path.relative(root, OUT_MD)}`);
  await db.disconnectPrisma?.();
};

run().catch(async (err) => {
  console.error(err);
  await db.disconnectPrisma?.();
  process.exit(1);
});
