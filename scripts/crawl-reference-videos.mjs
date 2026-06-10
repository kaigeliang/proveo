#!/usr/bin/env node
/**
 * 爆款参考视频批量入库脚本
 *
 * 用法:
 *   node scripts/crawl-reference-videos.mjs [选项]
 *
 * 选项:
 *   --categories=美妆,数码,食品     指定品类（逗号分隔）
 *   --count=3                      每个品类抓取数量（默认 3）
 *   --api=http://localhost:5001     后端地址
 *   --dry-run                      只打印，不入库
 *   --douyin-urls=URL1,URL2        抖音视频链接（逗号分隔）
 *   --sources=pexels,youtube,douyin 指定来源（默认全部）
 *
 * 环境变量:
 *   PEXELS_API_KEY      有则从 Pexels 拉真实 CC0 视频；无则用内置精选 URL
 *   YOUTUBE_API_KEY     YouTube Data API v3 密钥（Google Cloud Console 申请）
 *   ARK_API_KEY         用于 Doubao 拆解分析
 *   ARK_TEXT_MODEL_ID
 *   ARK_BASE_URL        (可选，默认火山方舟北京)
 *
 * 依赖:
 *   yt-dlp（YouTube/抖音视频下载）: brew install yt-dlp
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── CLI 参数 ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (name) => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

const CATEGORIES = (getArg('categories') || '美妆护肤,数码电子,食品饮料,服装服饰,家居家电')
  .split(',')
  .map((s) => s.trim());
const COUNT_PER_CAT = parseInt(getArg('count') || '3', 10);
const API_BASE = (getArg('api') || 'http://localhost:5001').replace(/\/$/, '');
const DRY_RUN = hasFlag('dry-run');
const DOUYIN_URLS_ARG = (getArg('douyin-urls') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const SOURCES_ARG = (getArg('sources') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ARK_KEY = process.env.ARK_API_KEY;
const ARK_MODEL = process.env.ARK_TEXT_MODEL_ID || process.env.ARK_MODEL_ID;
const ARK_BASE = (process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/$/, '');
const PEXELS_KEY = process.env.PEXELS_API_KEY;
const YOUTUBE_KEY = process.env.YOUTUBE_API_KEY;

let HAS_YTDLP = false;

// ─── 精选公开 CC0 视频库（Pexels 公开链接，品类对应） ────────────────────────

const CURATED = {
  美妆护肤: [
    {
      url: 'https://videos.pexels.com/video-files/3571264/3571264-uhd_2560_1440_30fps.mp4',
      title: '护肤品涂抹特写',
      style: '近景特写，高饱和暖光',
    },
    {
      url: 'https://videos.pexels.com/video-files/3568555/3568555-uhd_2560_1440_30fps.mp4',
      title: '粉底液质地展示',
      style: '白背景，慢镜头',
    },
    {
      url: 'https://videos.pexels.com/video-files/4046865/4046865-uhd_2560_1440_25fps.mp4',
      title: '口红色号展示',
      style: '产品旋转，光影层次',
    },
  ],
  数码电子: [
    {
      url: 'https://videos.pexels.com/video-files/3205028/3205028-uhd_2560_1440_25fps.mp4',
      title: '手机开箱展示',
      style: '科技感，冷色调',
    },
    {
      url: 'https://videos.pexels.com/video-files/3129957/3129957-uhd_2560_1440_25fps.mp4',
      title: '耳机佩戴演示',
      style: '生活化场景，人物出镜',
    },
    {
      url: 'https://videos.pexels.com/video-files/5878488/5878488-hd_1920_1080_25fps.mp4',
      title: '笔记本电脑使用场景',
      style: '办公环境，自然光',
    },
  ],
  食品饮料: [
    {
      url: 'https://videos.pexels.com/video-files/3209828/3209828-uhd_2560_1440_25fps.mp4',
      title: '咖啡冲泡过程',
      style: '暖色，慢镜头流动',
    },
    {
      url: 'https://videos.pexels.com/video-files/3209286/3209286-uhd_2560_1440_25fps.mp4',
      title: '食物摆盘特写',
      style: '餐厅环境，自然光',
    },
    {
      url: 'https://videos.pexels.com/video-files/4253925/4253925-hd_1920_1080_30fps.mp4',
      title: '水果新鲜切割',
      style: '清爽白背景，动感',
    },
  ],
  服装服饰: [
    {
      url: 'https://videos.pexels.com/video-files/4046466/4046466-uhd_2560_1440_25fps.mp4',
      title: '服装穿搭展示',
      style: '街头风，自然光',
    },
    {
      url: 'https://videos.pexels.com/video-files/3907245/3907245-uhd_2560_1440_25fps.mp4',
      title: '包包细节特写',
      style: '白背景，材质突出',
    },
    {
      url: 'https://videos.pexels.com/video-files/4507983/4507983-hd_1920_1080_25fps.mp4',
      title: '鞋款旋转展示',
      style: '360 度转台，简洁背景',
    },
  ],
  家居家电: [
    {
      url: 'https://videos.pexels.com/video-files/3129671/3129671-uhd_2560_1440_25fps.mp4',
      title: '家居环境展示',
      style: '温暖家庭感，自然光',
    },
    {
      url: 'https://videos.pexels.com/video-files/4107097/4107097-hd_1920_1080_25fps.mp4',
      title: '厨房电器使用',
      style: '功能演示，干净背景',
    },
    {
      url: 'https://videos.pexels.com/video-files/3571264/3571264-uhd_2560_1440_30fps.mp4',
      title: '收纳整理展示',
      style: '整洁感，俯拍',
    },
  ],
};

// 抖音精选爆款视频（手动维护，在此填入公开视频链接）
// 格式: https://www.douyin.com/video/7xxxxxxxxxxxxxxxxx
// 建议通过 --douyin-urls=URL1,URL2 参数传入，此列表作为保底
const DOUYIN_CURATED = [];

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(
      url,
      { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function post(url, body) {
  return fetchJson(url, { method: 'POST', body: JSON.stringify(body) });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const mod = url.startsWith('https') ? https : http;
    const doReq = (targetUrl) => {
      mod
        .get(targetUrl, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            return doReq(res.headers.location);
          }
          if (res.statusCode !== 200) {
            file.close();
            fs.unlinkSync(dest);
            return reject(new Error(`下载失败 ${res.statusCode}: ${targetUrl}`));
          }
          res.pipe(file);
          file.on('finish', () => file.close(resolve));
          res.on('error', reject);
        })
        .on('error', reject);
    };
    doReq(url);
  });
}

// ─── yt-dlp 工具 ─────────────────────────────────────────────────────────────

async function checkYtdlp() {
  try {
    await execFileAsync('yt-dlp', ['--version']);
    HAS_YTDLP = true;
  } catch {
    HAS_YTDLP = false;
  }
}

async function ytdlpMeta(url) {
  const { stdout } = await execFileAsync(
    'yt-dlp',
    ['--print-json', '--skip-download', '--no-warnings', '--quiet', url],
    { timeout: 30000 },
  );
  return JSON.parse(stdout.trim().split('\n')[0]);
}

async function ytdlpDownload(url, dest) {
  await execFileAsync(
    'yt-dlp',
    [
      '-o',
      dest,
      '--format',
      'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]/best',
      '--merge-output-format',
      'mp4',
      '--no-playlist',
      '--no-warnings',
      url,
    ],
    { timeout: 180000 },
  );
}

// ─── Pexels 搜索 ──────────────────────────────────────────────────────────────

async function searchPexels(query, perPage = 3) {
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=portrait`;
  const data = await fetchJson(url, { headers: { Authorization: PEXELS_KEY } });
  return (data.videos || [])
    .map((v) => {
      const file = v.video_files?.find((f) => f.quality === 'hd') || v.video_files?.[0];
      return {
        url: file?.link || '',
        title: v.user?.name ? `${query}·${v.user.name}` : query,
        style: `Pexels ${v.width}x${v.height}`,
        sourceDeclaration: `Pexels 免费视频 ID ${v.id}，CC0 授权，来源：https://www.pexels.com/video/${v.id}/`,
        licenseType: 'CC0',
      };
    })
    .filter((v) => v.url);
}

// ─── YouTube Data API ─────────────────────────────────────────────────────────

async function searchYouTube(query, maxResults = 3) {
  if (!YOUTUBE_KEY) return [];
  const searchQ = encodeURIComponent(`${query} 带货 短视频`);
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${searchQ}&type=video&maxResults=${maxResults}&videoDuration=short&key=${YOUTUBE_KEY}`;
  try {
    const data = await fetchJson(url);
    if (data.error) throw new Error(data.error.message);
    return (data.items || []).map((item) => ({
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      title: item.snippet.title,
      style: item.snippet.description?.slice(0, 80) || '带货短视频',
      sourceDeclaration: `YouTube 公开视频 ID:${item.id.videoId}，频道:${item.snippet.channelTitle}，仅作方法论分析参考，不流入创作。`,
      licenseType: 'public_reference',
      platform: 'youtube',
    }));
  } catch (err) {
    console.warn(`  [warn] YouTube API 搜索失败: ${err.message}`);
    return [];
  }
}

// ─── 抖音视频 ─────────────────────────────────────────────────────────────────

function getDouyinVideos(category) {
  const urls = DOUYIN_URLS_ARG.length ? DOUYIN_URLS_ARG : DOUYIN_CURATED;
  return urls.map((url) => ({
    url,
    title: `${category}抖音带货视频`,
    style: '抖音竖版带货短视频，快剪，字幕强调卖点',
    sourceDeclaration: '抖音公开视频，仅作方法论分析参考，不流入创作。',
    licenseType: 'public_reference',
    platform: 'douyin',
  }));
}

// ─── Doubao 拆解分析 ──────────────────────────────────────────────────────────

async function analyzeWithDoubao(category, title, style, platform) {
  if (!ARK_KEY || !ARK_MODEL) {
    console.log('  [skip] 未配置 Doubao，使用模板 breakdownReport');
    return buildTemplateBreakdown(category, title, style);
  }

  const platformHint = platform === 'youtube' ? '（来自 YouTube）' : platform === 'douyin' ? '（来自抖音）' : '';
  const prompt = `你是电商短视频拆解专家。请对以下爆款视频进行结构化拆解，严格输出 JSON，不要其他内容。

视频信息：
- 品类：${category}
- 标题：${title}${platformHint}
- 视觉风格：${style}

输出格式：
{
  "title": "视频标题",
  "sourceName": "来源平台",
  "hook": "前3秒钩子策略描述（一句话）",
  "sellingPoints": ["卖点1", "卖点2", "卖点3"],
  "shots": [
    {"order": 1, "role": "hook", "description": "开场分镜描述"},
    {"order": 2, "role": "proof", "description": "证据/细节分镜描述"},
    {"order": 3, "role": "demo", "description": "演示分镜描述"},
    {"order": 4, "role": "wrap", "description": "信息收束或决策建议分镜描述"}
  ],
  "style": "整体视觉风格总结",
  "paceRhythm": "节奏特点",
  "captionStrategy": "字幕策略"
}`;

  try {
    const resp = await fetchJson(`${ARK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ARK_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ARK_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
        max_tokens: 512,
        response_format: { type: 'json_object' },
      }),
    });
    const content = resp?.choices?.[0]?.message?.content;
    if (!content) throw new Error('Doubao 返回为空');
    return JSON.parse(content);
  } catch (err) {
    console.warn(`  [warn] Doubao 分析失败（${err.message}），使用模板`);
    return buildTemplateBreakdown(category, title, style);
  }
}

function buildTemplateBreakdown(category, title, style) {
  const roleMap = {
    美妆护肤: { hook: '前3秒展示使用前后对比，制造视觉冲击', points: ['成分天然安全', '上脸效果自然', '持久不脱妆'] },
    数码电子: { hook: '快速开箱，展示外观设计亮点', points: ['性能参数突出', '颜值设计感强', '使用体验流畅'] },
    食品饮料: { hook: '声音/颜色触发食欲，慢镜头特写', points: ['原料天然新鲜', '口感独特', '健康无添加'] },
    服装服饰: { hook: '人物上身效果，体型优化展示', points: ['版型修身好穿', '材质舒适透气', '多场景百搭'] },
    家居家电: { hook: '使用场景代入感，解决痛点', points: ['功能实用强大', '安装简单方便', '节省时间精力'] },
  };
  const t = roleMap[category] || { hook: '快速切入核心卖点', points: ['品质有保障', '性价比高', '用户好评多'] };
  return {
    title,
    sourceName: category,
    hook: t.hook,
    sellingPoints: t.points,
    shots: [
      { order: 1, role: 'hook', description: `${category}开场钩子，${t.hook}` },
      { order: 2, role: 'proof', description: `${category}核心卖点细节展示：${t.points[0]}` },
      { order: 3, role: 'demo', description: `${category}使用场景演示：${t.points[1]}` },
      { order: 4, role: 'wrap', description: `价格权益或适用场景收束，引导核对商品详情` },
    ],
    style,
    paceRhythm: '快节奏剪辑，每镜3-4秒',
    captionStrategy: '大字居中字幕，强调核心关键词',
  };
}

// ─── 主处理函数 ───────────────────────────────────────────────────────────────

async function processVideo(category, videoInfo, index) {
  const { url, title, style, sourceDeclaration, licenseType, platform } = videoInfo;
  const needsYtdlp = platform === 'youtube' || platform === 'douyin';
  const label = `[${category}][${index + 1}] ${title.slice(0, 40)}`;
  console.log(`\n${label}`);
  console.log(`  来源: ${url.slice(0, 80)}`);

  // yt-dlp 获取元数据（YouTube / 抖音）
  let metaTitle = title;
  let metaStyle = style;
  if (needsYtdlp && HAS_YTDLP && !DRY_RUN) {
    try {
      process.stdout.write('  获取元数据... ');
      const meta = await ytdlpMeta(url);
      metaTitle = meta.title || title;
      const tags = meta.tags?.slice(0, 3)?.join('/') || '';
      metaStyle = [meta.categories?.[0], tags].filter(Boolean).join('·') || style;
      console.log(`✓ "${metaTitle.slice(0, 50)}"`);
    } catch (err) {
      console.log(`  [skip] 元数据获取失败: ${err.message.slice(0, 60)}`);
    }
  }

  // 下载视频
  let localVideoUrl;
  if (!DRY_RUN) {
    const safeName = metaTitle.replace(/[^a-zA-Z0-9一-鿿]/g, '_').slice(0, 20);
    const filename = `ref_${Date.now()}_${safeName}.mp4`;
    const refDir = path.join(__dirname, '../apps/api/public/reference-videos');
    fs.mkdirSync(refDir, { recursive: true });
    const dest = path.join(refDir, filename);

    if (needsYtdlp) {
      if (HAS_YTDLP) {
        process.stdout.write('  yt-dlp 下载中... ');
        try {
          await ytdlpDownload(url, dest);
          if (fs.existsSync(dest)) {
            localVideoUrl = `/reference-videos/${filename}`;
            const stat = fs.statSync(dest);
            console.log(`✓ ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
          }
        } catch (err) {
          console.log(`  下载跳过: ${err.message.slice(0, 80)}`);
        }
      } else {
        console.log(`  [info] 跳过视频下载（需安装 yt-dlp: brew install yt-dlp）`);
      }
    } else {
      try {
        process.stdout.write('  下载中... ');
        await downloadFile(url, dest);
        localVideoUrl = `/reference-videos/${filename}`;
        const stat = fs.statSync(dest);
        console.log(`✓ ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
      } catch (err) {
        console.log(`  下载跳过: ${err.message}`);
      }
    }
  }

  // Doubao 拆解分析
  process.stdout.write('  Doubao 拆解分析... ');
  const breakdownReport = await analyzeWithDoubao(category, metaTitle, metaStyle, platform);
  console.log('✓');

  const video = {
    sourceUrl: url,
    localVideoUrl,
    title: breakdownReport.title || metaTitle,
    sourceDeclaration: sourceDeclaration || `公开素材，品类：${category}；用于比赛演示参考分析。`,
    licenseType: licenseType || 'public_reference',
    usageScope: 'analysis_and_creative',
    breakdownReport,
  };

  if (DRY_RUN) {
    console.log('  [dry-run] breakdownReport:', JSON.stringify(breakdownReport, null, 2).slice(0, 200), '...');
    return video;
  }

  const result = await post(`${API_BASE}/api/reference-videos/import`, { videos: [video] });
  if (result?.imported > 0) {
    console.log(`  ✓ 已入库: ${result.videos?.[0]?.id}`);
  } else {
    console.log(`  跳过: ${result?.skipped?.[0]?.reason || JSON.stringify(result)}`);
  }
  return video;
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

function sourceEnabled(name) {
  return !SOURCES_ARG.length || SOURCES_ARG.includes(name);
}

async function main() {
  await checkYtdlp();

  console.log('=== 爆款参考视频批量入库 ===');
  console.log(`品类: ${CATEGORIES.join(', ')}`);
  console.log(`每类数量: ${COUNT_PER_CAT}`);
  console.log(`后端: ${API_BASE}`);
  console.log(`Pexels API: ${PEXELS_KEY ? '已配置' : '未配置（使用内置精选 URL）'}`);
  console.log(`YouTube API: ${YOUTUBE_KEY ? '已配置' : '未配置（跳过 YouTube 来源，申请: console.cloud.google.com）'}`);
  console.log(
    `抖音 URLs: ${DOUYIN_URLS_ARG.length ? `${DOUYIN_URLS_ARG.length} 条（来自 --douyin-urls）` : DOUYIN_CURATED.length ? `${DOUYIN_CURATED.length} 条（内置精选）` : '未提供（使用 --douyin-urls=URL1,URL2 传入）'}`,
  );
  console.log(`yt-dlp: ${HAS_YTDLP ? '已安装 ✓' : '未安装（YouTube/抖音仅保存元数据，安装: brew install yt-dlp）'}`);
  console.log(`Doubao: ${ARK_KEY ? '已配置' : '未配置（使用模板 breakdownReport）'}`);
  console.log(`Dry-run: ${DRY_RUN}`);
  console.log('');

  let total = 0;

  // ── Pexels / 内置精选（按品类）────────────────────────────────────────────
  if (sourceEnabled('pexels')) {
    for (const category of CATEGORIES) {
      console.log(`\n─── ${category} (Pexels/内置) ───`);
      let videos = [];

      if (PEXELS_KEY) {
        try {
          videos = await searchPexels(category, COUNT_PER_CAT);
          console.log(`  Pexels 找到 ${videos.length} 条视频`);
        } catch (err) {
          console.warn(`  Pexels 搜索失败: ${err.message}，回退内置精选`);
        }
      }

      if (!videos.length) {
        const pool = CURATED[category] || CURATED['美妆护肤'];
        videos = pool.slice(0, COUNT_PER_CAT);
        console.log(`  使用内置精选 ${videos.length} 条视频`);
      }

      for (let i = 0; i < videos.length; i++) {
        await processVideo(category, videos[i], i);
        total++;
      }
    }
  }

  // ── YouTube（按品类搜索）────────────────────────────────────────────────────
  if (sourceEnabled('youtube')) {
    if (!YOUTUBE_KEY) {
      console.log('\n─── YouTube 来源：未配置 YOUTUBE_API_KEY，跳过 ───');
    } else {
      console.log('\n─── YouTube 来源 ───');
      for (const category of CATEGORIES) {
        process.stdout.write(`  搜索 ${category}... `);
        const videos = await searchYouTube(category, COUNT_PER_CAT);
        console.log(`找到 ${videos.length} 条`);
        for (let i = 0; i < videos.length; i++) {
          await processVideo(category, videos[i], i);
          total++;
        }
      }
    }
  }

  // ── 抖音（URL 列表）────────────────────────────────────────────────────────
  if (sourceEnabled('douyin')) {
    const douyinVideos = getDouyinVideos(CATEGORIES[0] || '通用');
    if (!douyinVideos.length) {
      console.log('\n─── 抖音来源：未提供 URL（使用 --douyin-urls=URL1,URL2 传入） ───');
    } else {
      console.log(`\n─── 抖音来源（${douyinVideos.length} 条）───`);
      if (!HAS_YTDLP) {
        console.log('  提示: 安装 yt-dlp 可下载视频文件: brew install yt-dlp');
      }
      for (let i = 0; i < douyinVideos.length; i++) {
        const category = CATEGORIES[i % CATEGORIES.length] || '通用';
        await processVideo(category, douyinVideos[i], i);
        total++;
      }
    }
  }

  console.log(`\n=== 完成，共处理 ${total} 条参考视频 ===`);

  if (!DRY_RUN) {
    const result = await fetchJson(`${API_BASE}/api/reference-videos`);
    console.log(`当前库中共 ${Array.isArray(result) ? result.length : '?'} 条参考视频`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
