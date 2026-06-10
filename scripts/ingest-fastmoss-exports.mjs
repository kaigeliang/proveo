#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import readXlsxFile from 'read-excel-file/node';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  require('dotenv').config({ path: path.join(repoRoot, '.env') });
} catch {
  // dotenv is optional for dry-run; Prisma will report missing DATABASE_URL on writes.
}

const DEFAULT_SOURCE = 'fastmoss';
const DEFAULT_PLATFORM = 'tiktok';

const ALIASES = {
  sourceUrl: [
    'sourceUrl',
    '来源链接',
    'fastmoss链接',
    '详情页链接',
    'FastMoss详情页链接',
    'FastMoss视频详情页链接',
    '页面链接',
    'URL',
  ],
  productExternalId: ['productExternalId', '商品ID', '商品id', 'productId', 'Product ID'],
  productTitle: ['productTitle', '商品标题', '商品名称', '产品标题', '产品名称', 'Product Title', 'Product'],
  category: ['category', '商品类目', '类目', '品类', '分类'],
  analysisWindow: ['analysisWindow', '日期范围', '分析周期', '统计周期', '时间范围'],
  analyzedCommentCount: ['analyzedCommentCount', '评论数', '评论数量', '分析评论数', '样本数'],
  consumerProfile: ['consumerProfile', '消费者画像', '消费者洞察', '用户画像', '消费人群'],
  starImpact: ['starImpact', '星级影响', '星级影响力', 'star influence'],
  usageScenarios: ['usageScenarios', '使用场景', '场景', '应用场景'],
  positiveExperience: ['positiveExperience', '正向体验', '好评体验', '好评点', '产品体验正向'],
  negativeExperience: ['negativeExperience', '负向体验', '差评体验', '吐槽点', '产品体验负向'],
  purchaseMotives: ['purchaseMotives', '购买动机', '购买原因', '购买驱动'],
  unmetExpectations: ['unmetExpectations', '未满足期望', '用户期望', '待满足需求'],
  summaryAdvice: ['summaryAdvice', '总结建议', '建议', '优化建议', '分析总结'],
  reviewText: ['reviewText', '评论内容', '评论原声', '原声', '评价内容', '买家评论', 'Comment', 'Review'],
  reviewedAt: ['reviewedAt', '评论时间', '评论日期', '评价时间', '日期', 'Review Date'],
  rating: ['rating', '星级', '评分', 'star', 'stars'],
  sku: ['sku', 'SKU', '规格', '变体', '款式', '颜色'],
  sentiment: ['sentiment', '情绪', '情感', '评价类型', '好评/差评', '正负向', 'Sentiment'],
  tags: ['tags', '标签', '评论标签', '情绪标签', '行为标签'],
  motives: ['motives', '购买动机标签', '购买动机', '动机标签'],
  expectations: ['expectations', '未满足期望标签', '用户期望标签', '期望标签'],
  behaviors: ['behaviors', '行为标签', '用户行为', '行为'],
  language: ['language', '语言', 'Language'],
  videoUrl: [
    'videoUrl',
    '视频链接',
    'TikTok链接',
    'TikTok帖子',
    'TikTok视频详情页链接',
    '帖子链接',
    '素材链接',
    'Video URL',
  ],
  videoId: ['videoId', '视频ID', '视频id', 'postId', 'Post ID'],
  productUrl: ['productUrl', '商品链接', '落地链接', 'Landing URL', 'Product URL'],
  shopName: ['shopName', '店铺', '店铺名称', 'Shop'],
  creatorHandle: ['creatorHandle', '达人', '达人ID', '达人id', '达人handle', '达人账号', 'Creator', '账号'],
  advertiserName: ['advertiserName', '广告主', '投放主体', 'Advertiser'],
  country: ['country', '国家', '国家/地区', '地区', '投放国家', 'Country'],
  adCopy: ['adCopy', '广告文案', '视频描述', '描述', '标题文案', '素材文案', 'Ad Copy'],
  publishedAt: ['publishedAt', '发布日期', '发布时间', '发布日'],
  firstSeenAt: ['firstSeenAt', '首次发现', '首次发现日期', 'First Seen'],
  lastSeenAt: ['lastSeenAt', '最后发现', '最后发现日期', 'Last Seen'],
  durationSeconds: ['durationSeconds', '时长', '视频时长', 'Duration'],
  resolution: ['resolution', '分辨率', '画幅', 'Resolution'],
  priceText: ['priceText', '价格', '商品价格', 'Price'],
  rankType: ['rankType', '榜单类型', '排序类型', 'Ranking Type'],
  rank: ['rank', '排名', '序号', 'Rank'],
  views: ['views', '播放量', '观看次数', '浏览量', '曝光', '曝光量', 'Views'],
  likes: ['likes', '点赞数', '点赞量', 'Likes'],
  comments: ['comments', '评论数', '评论量', 'Comments'],
  impressions: ['impressions', '展示量', '曝光次数', 'Impressions'],
  interactions: ['interactions', '互动', '互动量', '互动次数', 'Interactions'],
  adSpend: ['adSpend', '广告消耗', '广告花费', '投放消耗', '花费', 'Ad Spend', 'Spend'],
  sales: ['sales', '销量', '订单数', 'Sales', 'Conversions'],
  salesAmount: ['salesAmount', '销售额', '成交金额', 'GMV', 'Sales Amount'],
  roas: ['roas', 'ROAS', '广告ROAS'],
  ctr: ['ctr', 'CTR', '点击率'],
  interactionRate: ['interactionRate', '互动率', 'Engagement Rate'],
  adDays: ['adDays', '投放天数', '运行天数', 'Days Running'],
  sceneIndex: ['sceneIndex', '场景序号', '场景', '镜头', '分镜', 'Scene'],
  startMs: ['startMs', '开始时间', '开始', 'start', 'Start Time'],
  endMs: ['endMs', '结束时间', '结束', 'end', 'End Time'],
  summary: ['summary', '场景摘要', '摘要', '画面概述', '场景总结', 'Scene Summary'],
  transcript: ['transcript', '脚本', '口播', '字幕', '文案', 'Transcript'],
  labels: ['labels', '标签', 'action/product/comment', '场景标签'],
  ocrTexts: ['ocrTexts', 'OCR', 'ocr', '画面文字'],
  subtitlePlan: ['subtitlePlan', '字幕计划', '字幕位置', '字幕策略'],
  visual: ['visual', '视觉', '画面', '视觉描述'],
  referenceVideoId: ['referenceVideoId', '参考视频ID', 'ReferenceVideo ID'],
  creativePerformanceId: ['creativePerformanceId', '创意表现ID', 'CreativePerformance ID'],
};

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function printHelp() {
  console.log(`Usage:
  node scripts/ingest-fastmoss-exports.mjs --input=/path/to/export-or-dir [options]

Options:
  --kind=auto|voc|reviews|creative|scenes   Input kind. Default: auto.
  --source=fastmoss                         Source label written to DB. Default: fastmoss.
  --platform=tiktok                         Platform label written to DB. Default: tiktok.
  --out-dir=tmp/fastmoss-import             Normalized JSON output folder.
  --write-db                                Upsert normalized rows into Postgres.
  --limit=<n>                               Limit records per normalized kind.
  --voc-id=<id>                             Attach imported reviews to an existing VOC insight.
  --help                                    Show this help.

Inputs:
  - xlsx/csv/json files exported from FastMoss tables.
  - Directories are scanned one level deep for .xlsx, .csv and .json.
  - Auto mode recognizes VOC summaries, comment/review rows, AI video/ad performance rows and scene outlines.`);
}

function normalizeHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/[\s_:\-–—/\\()[\]{}"'“”‘’|，,。·.]+/g, '')
    .toLowerCase();
}

function readText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  if (value instanceof Date) return value.toISOString();
  return String(value).replace(/\s+/g, ' ').trim() || fallback;
}

function readNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  let text = String(value).trim();
  if (!text) return undefined;
  const negative = /^\(.*\)$/.test(text);
  text = text
    .replace(/[,\s¥$￥]/g, '')
    .replace(/[^\d.+\-()%万亿kKmM]/g, '')
    .replace(/[()]/g, '');
  let multiplier = 1;
  if (/万$/.test(text)) {
    multiplier = 10000;
    text = text.slice(0, -1);
  } else if (/亿$/.test(text)) {
    multiplier = 100000000;
    text = text.slice(0, -1);
  } else if (/k$/i.test(text)) {
    multiplier = 1000;
    text = text.slice(0, -1);
  } else if (/m$/i.test(text)) {
    multiplier = 1000000;
    text = text.slice(0, -1);
  }
  const percent = text.endsWith('%');
  if (percent) text = text.slice(0, -1);
  const number = Number(text) * multiplier * (negative ? -1 : 1);
  if (!Number.isFinite(number)) return undefined;
  return percent ? number / 100 : number;
}

function readInteger(value) {
  const number = readNumber(value);
  return number === undefined ? undefined : Math.round(number);
}

function parseExcelDateSerial(value) {
  if (typeof value !== 'number' || value < 20000 || value > 90000) return undefined;
  return new Date(Math.round((value - 25569) * 86400 * 1000));
}

function readDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const excelDate = parseExcelDateSerial(value);
  if (excelDate) return excelDate;
  const text = readText(value);
  if (!text) return undefined;
  const normalized = text
    .replace(/[年月]/g, '-')
    .replace(/[日号]/g, '')
    .replace(/\./g, '-')
    .replace(/\//g, '-');
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseDurationSeconds(value) {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'number') return value > 1000 ? value / 1000 : value;
  const text = readText(value).toLowerCase();
  let match = text.match(/^(\d+(?:\.\d+)?)\s*s$/);
  if (match) return Number(match[1]);
  match = text.match(/^(\d+(?:\.\d+)?)\s*秒$/);
  if (match) return Number(match[1]);
  match = text.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
  if (match) return Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] || 0}`);
  match = text.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/);
  if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] || 0}`);
  return readNumber(text);
}

function parseTimeMs(value) {
  const seconds = parseDurationSeconds(value);
  return seconds === undefined ? undefined : Math.max(0, Math.round(seconds * 1000));
}

function parseMaybeJson(value) {
  if (value === null || value === undefined || value === '') return undefined;
  if (Array.isArray(value) || (typeof value === 'object' && !(value instanceof Date))) return jsonSafe(value);
  const text = readText(value);
  if (!text) return undefined;
  if (/^[\[{]/.test(text)) {
    try {
      return jsonSafe(JSON.parse(text));
    } catch {
      // Fall through to list parsing.
    }
  }
  const parts = text
    .split(/[;；\n、|]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : text;
}

function jsonSafe(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]));
  }
  return value;
}

function buildHeaderIndex(row) {
  return new Map(Object.keys(row).map((key) => [normalizeHeader(key), key]));
}

function pick(row, name) {
  const aliases = ALIASES[name] || [name];
  const headers = buildHeaderIndex(row);
  for (const alias of aliases) {
    const key = headers.get(normalizeHeader(alias));
    if (key !== undefined) return row[key];
  }
  return undefined;
}

function stableHash(value) {
  return createHash('sha1')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 20);
}

function extractVideoId(url) {
  const text = readText(url);
  return (
    text.match(/\/video\/(\d+)/)?.[1] ||
    text.match(/[?&](?:video_id|id|item_id)=(\d+)/)?.[1] ||
    text.match(/\b(\d{15,22})\b/)?.[1] ||
    ''
  );
}

function normalizedSentiment(value) {
  const text = readText(value).toLowerCase();
  if (!text) return undefined;
  if (/(差评|负向|negative|bad|吐槽|不满)/i.test(text)) return 'negative';
  if (/(好评|正向|positive|good|满意)/i.test(text)) return 'positive';
  if (/(中性|neutral|mixed|一般)/i.test(text)) return 'neutral';
  return text;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted && char === '"' && next === '"') {
      cell += '"';
      i += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some((item) => item !== '')) rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += char;
  }
  row.push(cell);
  if (row.some((item) => item !== '')) rows.push(row);
  return rows;
}

function rowsToObjects(rows, file) {
  if (!rows.length) return [];
  const headers = rows[0].map((cell, index) => readText(cell) || `column_${index + 1}`);
  return rows
    .slice(1)
    .filter((row) => row.some((cell) => cell !== null && cell !== undefined && cell !== ''))
    .map((row, rowIndex) => {
      const object = { __file: file, __row: rowIndex + 2 };
      headers.forEach((header, index) => {
        object[header] = row[index];
      });
      return object;
    });
}

function jsonRecordsFromValue(value, file) {
  if (Array.isArray(value)) return value.map((row, index) => ({ __file: file, __row: index + 1, ...row }));
  if (!value || typeof value !== 'object') return [];
  const candidates = [];
  for (const key of [
    'rows',
    'data',
    'items',
    'list',
    'reviews',
    'comments',
    'creatives',
    'videos',
    'scenes',
    'vocInsights',
    'insights',
  ]) {
    if (Array.isArray(value[key])) candidates.push(...value[key]);
  }
  if (!candidates.length) candidates.push(value);
  return candidates.map((row, index) => ({ __file: file, __row: index + 1, ...row }));
}

async function readFileRecords(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') {
    const workbookRows = await readXlsxFile(file);
    const rows = Array.isArray(workbookRows?.[0]?.data) ? workbookRows[0].data : workbookRows;
    return rowsToObjects(rows, file);
  }
  if (ext === '.csv') {
    const text = await fs.readFile(file, 'utf8');
    return rowsToObjects(parseCsv(text), file);
  }
  if (ext === '.json') {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    return jsonRecordsFromValue(value, file);
  }
  return [];
}

async function findInputFiles(input) {
  const stat = await fs.stat(input);
  if (stat.isFile()) return [input];
  const entries = await fs.readdir(input, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(xlsx|xls|csv|json)$/i.test(entry.name))
    .map((entry) => path.join(input, entry.name))
    .sort();
}

function rowHas(row, names) {
  return names.some((name) => pick(row, name) !== undefined && readText(pick(row, name)) !== '');
}

function detectKind(row) {
  if (rowHas(row, ['reviewText'])) return 'reviews';
  if (rowHas(row, ['sceneIndex', 'startMs', 'endMs']) && rowHas(row, ['summary', 'transcript'])) return 'scenes';
  if (rowHas(row, ['consumerProfile', 'summaryAdvice', 'positiveExperience', 'negativeExperience'])) return 'voc';
  if (rowHas(row, ['roas', 'views', 'sales', 'adCopy', 'videoUrl'])) return 'creative';
  if (rowHas(row, ['summary', 'transcript'])) return 'scenes';
  return 'unknown';
}

function normalizeVoc(row, ctx) {
  const productTitle = readText(pick(row, 'productTitle'));
  if (!productTitle) return undefined;
  const sourceUrl = readText(pick(row, 'sourceUrl')) || undefined;
  return {
    id: readText(row.id) || `voc_${stableHash([ctx.source, productTitle, sourceUrl].join('|'))}`,
    source: ctx.source,
    platform: ctx.platform,
    sourceUrl,
    productExternalId: readText(pick(row, 'productExternalId')) || undefined,
    productTitle,
    category: readText(pick(row, 'category')) || undefined,
    analysisWindow: readText(pick(row, 'analysisWindow')) || undefined,
    analyzedCommentCount: readInteger(pick(row, 'analyzedCommentCount')),
    consumerProfile: parseMaybeJson(pick(row, 'consumerProfile')),
    starImpact: parseMaybeJson(pick(row, 'starImpact')),
    usageScenarios: parseMaybeJson(pick(row, 'usageScenarios')),
    positiveExperience: parseMaybeJson(pick(row, 'positiveExperience')),
    negativeExperience: parseMaybeJson(pick(row, 'negativeExperience')),
    purchaseMotives: parseMaybeJson(pick(row, 'purchaseMotives')),
    unmetExpectations: parseMaybeJson(pick(row, 'unmetExpectations')),
    summaryAdvice: readText(pick(row, 'summaryAdvice')) || undefined,
    raw: jsonSafe(row),
  };
}

function normalizeReview(row, ctx) {
  const reviewText = readText(pick(row, 'reviewText'));
  if (!reviewText) return undefined;
  const productTitle = readText(pick(row, 'productTitle')) || undefined;
  const reviewedAt = readDate(pick(row, 'reviewedAt'));
  const sku = readText(pick(row, 'sku')) || undefined;
  const sourceUrl = readText(pick(row, 'sourceUrl')) || undefined;
  return {
    id:
      readText(row.id) ||
      `review_${stableHash([ctx.source, productTitle, sku, reviewedAt?.toISOString(), reviewText].join('|'))}`,
    vocInsightId: readText(pick(row, 'vocInsightId')) || ctx.vocId || undefined,
    source: ctx.source,
    platform: ctx.platform,
    sourceUrl,
    productTitle,
    sku,
    reviewedAt,
    rating: readNumber(pick(row, 'rating')),
    language: readText(pick(row, 'language')) || undefined,
    sentiment: normalizedSentiment(pick(row, 'sentiment')),
    reviewText,
    tags: parseMaybeJson(pick(row, 'tags')),
    motives: parseMaybeJson(pick(row, 'motives')),
    expectations: parseMaybeJson(pick(row, 'expectations')),
    behaviors: parseMaybeJson(pick(row, 'behaviors')),
    raw: jsonSafe(row),
  };
}

function normalizeCreative(row, ctx) {
  const videoUrl = readText(pick(row, 'videoUrl')) || undefined;
  const sourceUrl = readText(pick(row, 'sourceUrl')) || undefined;
  const videoId = readText(pick(row, 'videoId')) || extractVideoId(videoUrl || sourceUrl) || undefined;
  const productTitle = readText(pick(row, 'productTitle')) || undefined;
  const adCopy = readText(pick(row, 'adCopy')) || undefined;
  if (!videoUrl && !sourceUrl && !productTitle && !adCopy) return undefined;
  const metrics = {
    views: readNumber(pick(row, 'views')),
    likes: readNumber(pick(row, 'likes')),
    comments: readNumber(pick(row, 'comments')),
    impressions: readNumber(pick(row, 'impressions')),
    interactions:
      readNumber(pick(row, 'interactions')) ??
      [readNumber(pick(row, 'likes')), readNumber(pick(row, 'comments'))]
        .filter((value) => value !== undefined)
        .reduce((sum, value) => sum + value, 0),
    adSpend: readNumber(pick(row, 'adSpend')),
    sales: readNumber(pick(row, 'sales')),
    salesAmount: readNumber(pick(row, 'salesAmount')),
    roas: readNumber(pick(row, 'roas')),
    ctr: readNumber(pick(row, 'ctr')),
    interactionRate: readNumber(pick(row, 'interactionRate')),
    adDays: readNumber(pick(row, 'adDays')),
  };
  const rankType = readText(pick(row, 'rankType')) || ctx.rankType || undefined;
  const rank = readInteger(pick(row, 'rank')) ?? (row.__row ? Math.max(1, Number(row.__row) - 1) : undefined);
  return {
    id:
      readText(row.id) ||
      `creative_${stableHash(
        [
          ctx.source,
          rankType,
          videoId || videoUrl || sourceUrl,
          rank,
          readText(pick(row, 'publishedAt')),
          readText(pick(row, 'views')),
          productTitle,
          adCopy,
        ].join('|'),
      )}`,
    source: ctx.source,
    platform: ctx.platform,
    sourceUrl,
    videoUrl,
    videoId,
    productTitle,
    productUrl: readText(pick(row, 'productUrl')) || undefined,
    shopName: readText(pick(row, 'shopName')) || undefined,
    creatorHandle: readText(pick(row, 'creatorHandle')) || undefined,
    advertiserName: readText(pick(row, 'advertiserName')) || undefined,
    country: readText(pick(row, 'country')) || undefined,
    category: readText(pick(row, 'category')) || undefined,
    adCopy,
    publishedAt: readDate(pick(row, 'publishedAt')),
    firstSeenAt: readDate(pick(row, 'firstSeenAt')),
    lastSeenAt: readDate(pick(row, 'lastSeenAt')),
    durationSeconds: parseDurationSeconds(pick(row, 'durationSeconds')),
    resolution: readText(pick(row, 'resolution')) || undefined,
    priceText: readText(pick(row, 'priceText')) || undefined,
    rankType,
    rank,
    ...metrics,
    metrics: jsonSafe(metrics),
    raw: jsonSafe(row),
  };
}

function normalizeScene(row, ctx) {
  const startMs = parseTimeMs(pick(row, 'startMs')) ?? 0;
  const endMs = parseTimeMs(pick(row, 'endMs')) ?? startMs;
  const summary = readText(pick(row, 'summary')) || readText(pick(row, 'visual'));
  const transcript = readText(pick(row, 'transcript')) || undefined;
  if (!summary && !transcript && startMs === endMs) return undefined;
  const videoUrl = readText(pick(row, 'videoUrl')) || undefined;
  const sceneIndex = readInteger(pick(row, 'sceneIndex')) ?? 0;
  return {
    id:
      readText(row.id) ||
      `scene_${stableHash([ctx.source, videoUrl, sceneIndex, startMs, endMs, summary, transcript].join('|'))}`,
    referenceVideoId: readText(pick(row, 'referenceVideoId')) || undefined,
    creativePerformanceId: readText(pick(row, 'creativePerformanceId')) || undefined,
    source: ctx.source,
    videoUrl,
    sceneIndex,
    startMs,
    endMs,
    summary: summary || transcript || 'Untitled scene',
    transcript,
    labels: parseMaybeJson(pick(row, 'labels')),
    ocrTexts: parseMaybeJson(pick(row, 'ocrTexts')),
    subtitlePlan: parseMaybeJson(pick(row, 'subtitlePlan')),
    visual: parseMaybeJson(pick(row, 'visual')),
    raw: jsonSafe(row),
  };
}

function applyLimit(items, limit) {
  if (!limit) return items;
  return items.slice(0, Math.max(1, Number(limit)));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(jsonSafe(value), null, 2)}\n`);
}

async function writeDb(normalized) {
  const db = require('@aigc-video-hub/db');
  let vocInsights = 0;
  let reviewInsights = 0;
  let creativePerformances = 0;
  let sceneTruths = 0;
  try {
    for (const insight of normalized.vocInsights) {
      await db.upsertProductVocInsight(insight);
      vocInsights += 1;
    }
    for (const creative of normalized.creativePerformances) {
      await db.upsertCreativePerformance(creative);
      creativePerformances += 1;
    }
    for (const review of normalized.reviewInsights) {
      await db.upsertProductReviewInsight(review);
      reviewInsights += 1;
    }
    for (const scene of normalized.sceneTruths) {
      await db.upsertVideoSceneTruth(scene);
      sceneTruths += 1;
    }
  } finally {
    await db.disconnectPrisma?.();
  }
  return { vocInsights, reviewInsights, creativePerformances, sceneTruths };
}

if (hasFlag('help')) {
  printHelp();
  process.exit(0);
}

const input = readArg('input');
if (!input) {
  printHelp();
  process.exit(1);
}

const kind = readArg('kind', 'auto');
const source = readArg('source', DEFAULT_SOURCE);
const platform = readArg('platform', DEFAULT_PLATFORM);
const outDir = path.resolve(readArg('out-dir', 'tmp/fastmoss-import'));
const limit = readArg('limit');
const writeDatabase = hasFlag('write-db');
const ctx = {
  source,
  platform,
  vocId: readArg('voc-id'),
  rankType: readArg('rank-type'),
};

const files = await findInputFiles(path.resolve(input));
if (!files.length) throw new Error(`No .xlsx/.csv/.json files found under ${input}`);

const rawRecords = [];
for (const file of files) {
  const records = await readFileRecords(file);
  rawRecords.push(...records);
  console.error(`[fastmoss] read ${records.length} rows from ${path.relative(repoRoot, file)}`);
}

const normalized = {
  vocInsights: [],
  reviewInsights: [],
  creativePerformances: [],
  sceneTruths: [],
  skipped: [],
};

for (const row of rawRecords) {
  const rowKind = kind === 'auto' ? detectKind(row) : kind;
  const normalizedRow =
    rowKind === 'voc'
      ? normalizeVoc(row, ctx)
      : rowKind === 'reviews'
        ? normalizeReview(row, ctx)
        : rowKind === 'creative'
          ? normalizeCreative(row, ctx)
          : rowKind === 'scenes'
            ? normalizeScene(row, ctx)
            : undefined;
  if (!normalizedRow) {
    normalized.skipped.push({ file: row.__file, row: row.__row, reason: `unrecognized_or_empty_${rowKind}` });
    continue;
  }
  if (rowKind === 'voc') normalized.vocInsights.push(normalizedRow);
  if (rowKind === 'reviews') normalized.reviewInsights.push(normalizedRow);
  if (rowKind === 'creative') normalized.creativePerformances.push(normalizedRow);
  if (rowKind === 'scenes') normalized.sceneTruths.push(normalizedRow);
}

const vocByProduct = new Map(
  normalized.vocInsights.map((insight) => [normalizeHeader(insight.productTitle), insight.id]),
);
for (const review of normalized.reviewInsights) {
  if (!review.vocInsightId && review.productTitle) {
    review.vocInsightId = vocByProduct.get(normalizeHeader(review.productTitle));
  }
}

const limited = {
  vocInsights: applyLimit(normalized.vocInsights, limit),
  reviewInsights: applyLimit(normalized.reviewInsights, limit),
  creativePerformances: applyLimit(normalized.creativePerformances, limit),
  sceneTruths: applyLimit(normalized.sceneTruths, limit),
  skipped: normalized.skipped,
};

await writeJson(path.join(outDir, 'voc-insights.json'), limited.vocInsights);
await writeJson(path.join(outDir, 'review-insights.json'), limited.reviewInsights);
await writeJson(path.join(outDir, 'creative-performances.json'), limited.creativePerformances);
await writeJson(path.join(outDir, 'scene-truths.json'), limited.sceneTruths);

const summary = {
  input: path.resolve(input),
  files: files.map((file) => path.relative(repoRoot, file)),
  kind,
  source,
  platform,
  writeDatabase,
  counts: {
    rawRecords: rawRecords.length,
    vocInsights: limited.vocInsights.length,
    reviewInsights: limited.reviewInsights.length,
    creativePerformances: limited.creativePerformances.length,
    sceneTruths: limited.sceneTruths.length,
    skipped: limited.skipped.length,
  },
  outDir: path.relative(repoRoot, outDir),
};

if (writeDatabase) {
  summary.dbWrites = await writeDb(limited);
}

await writeJson(path.join(outDir, 'summary.json'), summary);
console.log(JSON.stringify(summary, null, 2));
