#!/usr/bin/env node
/**
 * 快速测试 benchmark scorer。
 * 用法：node scripts/test-scorer.mjs [category]
 *
 * 从 benchmark-test.jsonl 取最高/中等/最低分各一条，
 * 直接在 Node.js 里跑 PCA + LightGBM 推理（不需要启动 API）。
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── 加载模型 ──────────────────────────────────────────────────────────────────
const model = JSON.parse(
  readFileSync(join(ROOT, 'apps/api/src/lib/scoring/scorer-model.json'), 'utf-8'),
);
const testSet = readFileSync(
  join(ROOT, 'tmp/kalodata-test/benchmark-test.jsonl'), 'utf-8',
).split('\n').filter(Boolean).map(JSON.parse);

const pcaMean   = model.pca.mean;
const pcaComps  = model.pca.components;
const topCats   = model.features.topCategories;
const maxDurLog = model.features.maxDurationLog;
const cohorts   = model.cohorts;

// ── 数学工具 ──────────────────────────────────────────────────────────────────
function dot(a, b) {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s;
}
function norm(a) { return Math.sqrt(dot(a, a)); }
function cosine(a, b) { return dot(a, b) / (norm(a) * norm(b) + 1e-10); }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function r4(v) { return Math.round(v * 1e4) / 1e4; }

function projectPCA(emb) {
  const centered = emb.map((v, i) => v - pcaMean[i]);
  return pcaComps.map(comp => dot(centered, comp));
}

function evalTree(features, tree) {
  let node = 0;
  while (node >= 0) {
    node = features[tree.split_feature[node]] <= tree.threshold[node]
      ? tree.left_child[node] : tree.right_child[node];
  }
  return tree.leaf_value[~node];
}

function predictLGBM(features, lgbm) {
  return lgbm.base_score + lgbm.trees.reduce((s, t) => s + evalTree(features, t), 0);
}

function buildFeatures(emb, simOrg, simPaid, simLF, dur, cat) {
  const pca     = projectPCA(emb);
  const durNorm = Math.log1p(Math.max(0, dur)) / maxDurLog;
  const catOhe  = topCats.map(c => c === cat ? 1 : 0);
  const catOther = topCats.includes(cat) ? 0 : 1;
  return [...pca, simOrg, simPaid, simLF, durNorm, ...catOhe, catOther];
}

function score(sample) {
  const emb     = sample.embedding;
  const cat     = sample.category ?? '';
  const dur     = sample.durationSeconds ?? 0;

  const simOrg  = cosine(emb, cohorts.organic_sales_videos);
  const simPaid = cosine(emb, cohorts.high_roas_ads);
  const simLF   = cosine(emb, cohorts.low_follower_videos);

  const feats   = buildFeatures(emb, simOrg, simPaid, simLF, dur, cat);
  const raw     = predictLGBM(feats, model.scorer);
  const orgLogit = predictLGBM(feats, model.classifiers.organicWinner);
  const lfLogit  = predictLGBM(feats, model.classifiers.lowFollowerWinner);

  const sims = [['organic', simOrg], ['paid_roas', simPaid], ['low_follower', simLF]];
  const archetype = sims.reduce((b, c) => c[1] > b[1] ? c : b)[0];

  return {
    category:    cat,
    durationSec: dur,
    trueScore:   r4(sample.labels.benchmarkScore),
    predScore:   r4(Math.max(0, Math.min(1, raw))),
    error:       r4(Math.max(0, Math.min(1, raw)) - sample.labels.benchmarkScore),
    organicProb: r4(sigmoid(orgLogit)),
    lfProb:      r4(sigmoid(lfLogit)),
    archetype,
    datasets:    sample.datasets,
    gmvPct:      sample.labels.gmvPercentile,
    convPct:     sample.labels.gmvPerMilleViewsPercentile,
    sims:        { organic: r4(simOrg), paid: r4(simPaid), lowFollower: r4(simLF) },
    ref:         (sample.referenceText ?? '').slice(0, 80),
  };
}

// ── 选取展示样本 ───────────────────────────────────────────────────────────────
const filterCat = process.argv[2]; // 可选：按类目过滤
const pool = filterCat
  ? testSet.filter(s => (s.category ?? '').includes(filterCat))
  : testSet;

if (!pool.length) {
  console.error(`找不到类目包含 "${filterCat}" 的样本`);
  process.exit(1);
}

const sorted   = [...pool].sort((a, b) => a.labels.benchmarkScore - b.labels.benchmarkScore);
const showcase = pool.length >= 3
  ? [sorted.at(-1), sorted[Math.floor(sorted.length / 2)], sorted[0]]
  : sorted;

// ── 打印 ──────────────────────────────────────────────────────────────────────
console.log('\n══ Benchmark Scorer 推理测试 ══\n');
for (const s of showcase) {
  const r = score(s);
  const errSign = r.error >= 0 ? '+' : '';
  console.log(`【${r.category}】  ${r.durationSec}s`);
  console.log(`  真实分: ${r.trueScore.toFixed(3)}  预测分: ${r.predScore.toFixed(3)}  误差: ${errSign}${r.error.toFixed(3)}`);
  console.log(`  GMV分位: ${r.gmvPct ?? '-'}  转化分位: ${r.convPct ?? '-'}`);
  console.log(`  自然爆款概率: ${(r.organicProb * 100).toFixed(1)}%  小粉丝爆款概率: ${(r.lfProb * 100).toFixed(1)}%`);
  console.log(`  Archetype: ${r.archetype}  来源: ${(r.datasets ?? []).join(' + ')}`);
  console.log(`  相似度 → organic:${r.sims.organic}  paid:${r.sims.paid}  lowFol:${r.sims.lowFollower}`);
  console.log(`  内容: ${r.ref}`);
  console.log();
}

// 汇总整体误差
const allScores = pool.map(s => score(s));
const maes = allScores.map(r => Math.abs(r.error));
const mae  = maes.reduce((a, b) => a + b, 0) / maes.length;
const pairs = allScores.map(r => [r.trueScore, r.predScore]);
const n = pairs.length;
const rTrue = pairs.map(p => p[0]);
const rPred = pairs.map(p => p[1]);
const meanT = rTrue.reduce((a,b)=>a+b,0)/n, meanP = rPred.reduce((a,b)=>a+b,0)/n;
const cov = pairs.reduce((s,p)=>s+(p[0]-meanT)*(p[1]-meanP),0)/n;
const stdT = Math.sqrt(rTrue.reduce((s,v)=>s+(v-meanT)**2,0)/n);
const stdP = Math.sqrt(rPred.reduce((s,v)=>s+(v-meanP)**2,0)/n);
const pearson = stdT && stdP ? cov/(stdT*stdP) : 0;

console.log(`── 汇总（${pool.length} 条${filterCat ? ` | 类目:${filterCat}` : ''}）──`);
console.log(`  MAE: ${mae.toFixed(4)}  Pearson: ${pearson.toFixed(4)}`);
console.log(`  模型版本: v${model.version}  训练样本: ${model.trainCount}  PCA维度: ${model.pca.nComponents}`);
console.log(`  测试集指标: MAE=${model.metrics.test.mae}  Spearman=${model.metrics.test.spearman}  NDCG@20=${model.metrics.test.ndcgAt20}\n`);
