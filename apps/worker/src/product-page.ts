import { fetchPublicHtml } from './research';

export type ProductPageAssets = {
  images: string[];
  title?: string;
  description?: string;
  price?: string;
};

const MAX_PRODUCT_IMAGES = 4;

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function compactText(value: string) {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function readAttribute(tag: string, name: string) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const match = tag.match(pattern);
  return decodeHtmlEntities((match?.[2] || match?.[3] || match?.[4] || '').trim());
}

function metaTags(html: string) {
  return [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => match[0]);
}

function metaKey(tag: string) {
  return (
    readAttribute(tag, 'property') ||
    readAttribute(tag, 'name') ||
    readAttribute(tag, 'itemprop') ||
    ''
  ).toLowerCase();
}

function firstMetaContent(html: string, keys: string[]) {
  const tags = metaTags(html);
  const normalizedKeys = keys.map((key) => key.toLowerCase());
  for (const key of normalizedKeys) {
    for (const tag of tags) {
      if (metaKey(tag) === key) {
        const content = readAttribute(tag, 'content');
        if (content) return compactText(content);
      }
    }
  }
  return undefined;
}

function allMetaContent(html: string, keys: string[]) {
  const keySet = new Set(keys.map((key) => key.toLowerCase()));
  return metaTags(html)
    .filter((tag) => keySet.has(metaKey(tag)))
    .map((tag) => readAttribute(tag, 'content'))
    .filter(Boolean);
}

function pageTitle(html: string) {
  const fromMeta = firstMetaContent(html, ['og:title', 'twitter:title']);
  if (fromMeta) return fromMeta.slice(0, 160);
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = match ? compactText(match[1]) : '';
  return title ? title.slice(0, 160) : undefined;
}

function pageDescription(html: string) {
  return firstMetaContent(html, ['og:description', 'twitter:description', 'description'])?.slice(0, 500);
}

function pagePrice(html: string) {
  const metaPrice = firstMetaContent(html, ['product:price:amount', 'og:price:amount', 'twitter:data1', 'price']);
  if (metaPrice) return metaPrice.slice(0, 80);

  const itemPropMatch = html.match(/<[^>]+\bitemprop=["']price["'][^>]*>/i);
  const itemPropPrice = itemPropMatch ? readAttribute(itemPropMatch[0], 'content') : '';
  if (itemPropPrice) return itemPropPrice.slice(0, 80);

  const text = compactText(html).slice(0, 20_000);
  const priceMatch = text.match(/(?:[$¥￥]\s?\d[\d,.]*|\d[\d,.]*\s?(?:元|CNY|USD))/i);
  return priceMatch?.[0]?.slice(0, 80);
}

function resolveAssetUrl(rawUrl: string, pageUrl: URL) {
  const cleaned = decodeHtmlEntities(rawUrl).trim();
  if (!cleaned || cleaned.startsWith('data:') || cleaned.startsWith('blob:')) return undefined;
  try {
    const url = new URL(cleaned, pageUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function srcsetCandidate(value: string) {
  const candidates = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [url, descriptor = ''] = item.split(/\s+/, 2);
      const score = Number(descriptor.match(/(\d+(?:\.\d+)?)(?:w|x)/)?.[1] || 0);
      return { url, score };
    })
    .filter((item) => item.url);
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.url || '';
}

function imageLooksUsable(tag: string, rawUrl: string) {
  const haystack = `${tag} ${rawUrl}`.toLowerCase();
  if (/sprite|favicon|logo|icon|avatar|placeholder|blank|loading|pixel|tracking/.test(haystack)) return false;
  if (/\.(svg|ico)(?:[?#]|$)/i.test(rawUrl)) return false;

  const width = Number(readAttribute(tag, 'width'));
  const height = Number(readAttribute(tag, 'height'));
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return width >= 180 && height >= 180;
  }
  return true;
}

function imgCandidates(html: string) {
  const output: string[] = [];
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const rawValues = [
      srcsetCandidate(readAttribute(tag, 'srcset')),
      srcsetCandidate(readAttribute(tag, 'data-srcset')),
      readAttribute(tag, 'src'),
      readAttribute(tag, 'data-src'),
      readAttribute(tag, 'data-original'),
      readAttribute(tag, 'data-lazy-src'),
      readAttribute(tag, 'data-ks-lazyload'),
      readAttribute(tag, 'data-lazyload'),
    ].filter(Boolean);
    for (const rawValue of rawValues) {
      if (imageLooksUsable(tag, rawValue)) output.push(rawValue);
    }
  }
  return output;
}

function jsonLdImageCandidates(html: string) {
  const output: string[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = decodeHtmlEntities(match[1]);
    for (const imageMatch of body.matchAll(/"image"\s*:\s*(?:"([^"]+)"|\[([\s\S]*?)\])/gi)) {
      if (imageMatch[1]) output.push(imageMatch[1]);
      if (imageMatch[2]) {
        for (const item of imageMatch[2].matchAll(/"([^"]+)"/g)) output.push(item[1]);
      }
    }
  }
  return output;
}

function uniqueResolvedImages(pageUrl: URL, candidates: string[]) {
  const seen = new Set<string>();
  const images: string[] = [];
  for (const candidate of candidates) {
    const resolved = resolveAssetUrl(candidate, pageUrl);
    if (!resolved) continue;
    const key = resolved.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    images.push(resolved);
    if (images.length >= MAX_PRODUCT_IMAGES) break;
  }
  return images;
}

export async function fetchProductPageAssets(url: string): Promise<ProductPageAssets> {
  const pageUrl = new URL(url);
  if (!['http:', 'https:'].includes(pageUrl.protocol)) {
    throw new Error('Only http(s) product URLs can be ingested');
  }

  const html = await fetchPublicHtml(pageUrl.toString(), { timeoutMs: 8000 });
  const metaImages = allMetaContent(html, [
    'og:image',
    'og:image:url',
    'og:image:secure_url',
    'twitter:image',
    'twitter:image:src',
  ]);

  const images = uniqueResolvedImages(pageUrl, [...metaImages, ...jsonLdImageCandidates(html), ...imgCandidates(html)]);

  return {
    images,
    title: pageTitle(html),
    description: pageDescription(html),
    price: pagePrice(html),
  };
}
