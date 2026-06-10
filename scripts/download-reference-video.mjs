import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:5001/api';
const REPO_ROOT = fileURLToPath(new URL('../aigc-video-hub/', import.meta.url));
const PUBLIC_DIR = path.join(REPO_ROOT, 'apps/api/public');
const DOWNLOAD_DIR = path.join(PUBLIC_DIR, 'reference-videos');

function readArg(name, fallback = '') {
  const exact = process.argv.find((item) => item.startsWith(`--${name}=`));
  if (exact) return exact.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function slug(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 72) || 'reference-video'
  );
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlAttr(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match =
    html.match(new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, 'i')) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["']`, 'i'));
  return match ? decodeHtml(match[1]) : '';
}

function titleFromHtml(html, fallback) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title
    ? decodeHtml(
        title
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
    : fallback;
}

async function resolveVideoUrl(inputUrl) {
  if (/\.(mp4|mov|webm)(\?|#|$)/i.test(inputUrl)) {
    return {
      videoUrl: inputUrl,
      pageTitle: readArg('title', '公开视频参考素材'),
    };
  }

  const response = await fetch(inputUrl, {
    headers: {
      'user-agent': 'Mozilla/5.0 aimatch-reference-video-downloader/1.0',
    },
    signal: AbortSignal.timeout(12_000),
  });
  const html = await response.text();
  if (!response.ok) throw new Error(`页面抓取失败：${response.status}`);

  const candidates = [
    htmlAttr(html, 'og:video:secure_url'),
    htmlAttr(html, 'og:video:url'),
    htmlAttr(html, 'og:video'),
    htmlAttr(html, 'twitter:player:stream'),
    html.match(/<video[^>]+src=["']([^"']+)["']/i)?.[1] || '',
    html.match(/<source[^>]+src=["']([^"']+)["'][^>]+type=["']video\//i)?.[1] || '',
  ].filter(Boolean);

  const direct = candidates.find((item) => /\.(mp4|mov|webm)(\?|#|$)/i.test(item));
  if (!direct) {
    throw new Error('没有在页面中找到直接可下载的 mp4/mov/webm 视频地址；请传 --url=直链视频地址');
  }
  return {
    videoUrl: new URL(direct, inputUrl).toString(),
    pageTitle: readArg('title', titleFromHtml(html, '公开视频参考素材')),
  };
}

async function request(pathname, options = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${options.method || 'GET'} ${pathname} -> ${response.status}: ${text}`);
  return data;
}

const sourceUrl = readArg('url');
if (!sourceUrl) throw new Error('需要 --url=公开视频页面或 mp4/mov/webm 直链');

const sourceName = readArg('source', '公开公开视频');
const licenseType = readArg('license', 'public_reference');
const usageScope = readArg('usage', 'analysis_and_creative');
const { videoUrl, pageTitle } = await resolveVideoUrl(sourceUrl);

await mkdir(DOWNLOAD_DIR, { recursive: true });
const extension = path.extname(new URL(videoUrl).pathname).replace(/[^a-z0-9.]/gi, '') || '.mp4';
const filename = `${Date.now()}_${slug(pageTitle)}${extension}`;
const filePath = path.join(DOWNLOAD_DIR, filename);

const videoResponse = await fetch(videoUrl, {
  headers: {
    'user-agent': 'Mozilla/5.0 aimatch-reference-video-downloader/1.0',
  },
  signal: AbortSignal.timeout(120_000),
});
if (!videoResponse.ok || !videoResponse.body) throw new Error(`视频下载失败：${videoResponse.status}`);

await pipeline(videoResponse.body, createWriteStream(filePath));

const localVideoUrl = `/reference-videos/${filename}`;
const sourceDeclaration = readArg(
  'declaration',
  `${sourceName}；公开视频下载缓存；来源：${sourceUrl}；本项目为比赛演示/学习用途，页面中展示来源声明。`,
);
const imported = await request('/reference-videos/import', {
  method: 'POST',
  body: JSON.stringify({
    videos: [
      {
        sourceUrl,
        localVideoUrl,
        sourceDeclaration,
        licenseType,
        usageScope,
        breakdownReport: {
          title: pageTitle,
          sourceName,
          hook: readArg('hook', '前三秒展示痛点或利益点'),
          sellingPoints: readArg('points', '公开视频参考素材,来源已声明')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
          shots: [
            {
              order: 1,
              role: 'hook',
              description: '参考公开视频的开场节奏，重写为当前商品钩子。',
            },
            {
              order: 2,
              role: 'proof',
              description: '展示商品真实细节或使用证据。',
            },
            {
              order: 3,
              role: 'demo',
              description: '用场景化演示解释决策理由。',
            },
            {
              order: 4,
              role: 'cta',
              description: '以页面实时权益为准，引导查看商品详情。',
            },
          ],
          style: readArg('style', '公开爆款带货视频参考'),
          factors: [
            {
              type: 'hook类型',
              value: '问题式开场',
              sourceStrategy: 'downloaded_public_reference',
            },
            {
              type: '视角',
              value: '买家视角实测',
              sourceStrategy: 'downloaded_public_reference',
            },
            {
              type: '画面重点',
              value: '真实场景证明',
              sourceStrategy: 'downloaded_public_reference',
            },
          ],
          localVideoUrl,
          crawledAt: new Date().toISOString(),
        },
      },
    ],
  }),
});

console.log(
  JSON.stringify(
    {
      api: API_BASE,
      sourceUrl,
      videoUrl,
      localVideoUrl,
      filePath,
      imported: imported.imported,
      skipped: imported.skipped,
      id: imported.videos[0]?.id,
      title: imported.videos[0]?.breakdownReport?.title,
    },
    null,
    2,
  ),
);
