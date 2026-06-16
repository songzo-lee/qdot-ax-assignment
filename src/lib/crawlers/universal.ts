import type { RawProduct } from '../schemas/product';
import { cafe24Adapter } from './adapters/cafe24';
import { genericAdapter } from './adapters/generic';
import { firstmallAdapter } from './adapters/firstmall';
import { godomallAdapter } from './adapters/godomall';
import { naverBrandAdapter } from './adapters/naver-brand';
import { naverSmartAdapter } from './adapters/naver-smart';
import { nuxtAdapter } from './adapters/nuxt';
import { wordpressAdapter } from './adapters/wordpress';
import type { CrawlerAdapter } from './adapters/types';
import { happylandAdapter } from './happyland';
import { filterSoldOutProducts } from './sold-out';
import { fetchHtmlWithFallbackAndUrl } from './utils';

type RouteCandidate = {
  adapter: CrawlerAdapter;
  score: number;
  reason: string[];
};

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function addIfMatch(
  reason: string[],
  score: number,
  condition: boolean,
  message: string,
  amount: number,
): number {
  if (!condition) return score;
  reason.push(message);
  return score + amount;
}

function scoreNaverBrand(url: string, html = ''): RouteCandidate {
  const reasons: string[] = [];
  let score = 0;
  const parsed = safeUrl(url);

  score = addIfMatch(reasons, score, url.includes('brand.naver.com'), 'brand.naver.com', 100);
  score = addIfMatch(
    reasons,
    score,
    html.includes('brand.naver.com'),
    'HTML contains brand.naver.com',
    30,
  );
  score = addIfMatch(
    reasons,
    score,
    html.includes('channelUid') || html.includes('NaverBrand'),
    'Naver Brand script/data',
    20,
  );

  if (parsed?.hostname === 'brand.naver.com') {
    score += 20;
    reasons.push('brand.naver.com host');
  }

  return { adapter: naverBrandAdapter, score, reason: reasons };
}

function scoreNaverSmart(url: string, html = ''): RouteCandidate {
  const reasons: string[] = [];
  let score = 0;
  const parsed = safeUrl(url);

  score = addIfMatch(
    reasons,
    score,
    url.includes('smartstore.naver.com'),
    'smartstore.naver.com',
    100,
  );
  score = addIfMatch(
    reasons,
    score,
    html.includes('smartstore.naver.com') || html.includes('__NEXT_DATA__'),
    'Smart Store script/data',
    25,
  );
  if (parsed?.hostname === 'smartstore.naver.com') {
    score += 20;
    reasons.push('smartstore.naver.com host');
  }

  return { adapter: naverSmartAdapter, score, reason: reasons };
}

function scoreHappyland(url: string, html = ''): RouteCandidate {
  const reasons: string[] = [];
  let score = 0;
  const parsed = safeUrl(url);

  score = addIfMatch(
    reasons,
    score,
    url.includes('happylandmall.com'),
    'happylandmall.com',
    100,
  );
  score = addIfMatch(
    reasons,
    score,
    html.includes('happylandmall.com') || html.includes('happyland'),
    'Happyland signals',
    20,
  );
  if (parsed?.hostname.endsWith('happylandmall.com')) {
    score += 20;
    reasons.push('happylandmall.com host');
  }

  return { adapter: happylandAdapter, score, reason: reasons };
}

function scoreNuxt(url: string, html = ''): RouteCandidate {
  const reasons: string[] = [];
  let score = 0;

  score = addIfMatch(reasons, score, url.includes('/_nuxt/'), '/_nuxt/ url', 100);
  score = addIfMatch(reasons, score, html.includes('/_nuxt/'), '/_nuxt/ html', 40);
  score = addIfMatch(reasons, score, html.includes('__NUXT__'), '__NUXT__', 80);
  score = addIfMatch(
    reasons,
    score,
    html.includes('__NUXT_DATA__'),
    '__NUXT_DATA__',
    80,
  );
  score = addIfMatch(
    reasons,
    score,
    html.includes('id="__nuxt"') || html.includes("id='__nuxt'"),
    '__nuxt root',
    60,
  );
  score = addIfMatch(reasons, score, html.includes('data-n-head'), 'data-n-head', 20);

  return { adapter: nuxtAdapter, score, reason: reasons };
}

function scoreCafe24(url: string, html = ''): RouteCandidate {
  const reasons: string[] = [];
  let score = 0;
  const parsed = safeUrl(url);
  const host = parsed?.hostname ?? '';
  const cafe24Host =
    /(?:^|\.)cafe24\.com$/i.test(host) ||
    /(?:^|\.)cafe24shop\.com$/i.test(host) ||
    /(?:^|\.)mycafe24\.com$/i.test(host);
  const urlSignals =
    url.includes('/product/list.html') || url.includes('/product/detail.html');
  const htmlSignals = [
    'EC_FRONT_EXTERNAL_SCRIPT_VARIABLE_DATA',
    '/ind-script/optimizer.php',
    'xans-',
    'xans-product-',
    'EC-Product-list',
    'img.echosting.cafe24.com',
    'img.cafe24.com',
    'CAFE24',
  ].filter((marker) => html.includes(marker)).length;

  score = addIfMatch(reasons, score, cafe24Host, host, 100);
  score = addIfMatch(reasons, score, urlSignals, 'product list/detail path', 30);
  if (htmlSignals > 0) {
    score += htmlSignals * 12;
    reasons.push(`${htmlSignals} cafe24 html signals`);
  }
  if (html.includes('EC_FRONT_EXTERNAL_SCRIPT_VARIABLE_DATA')) {
    score += 20;
    reasons.push('EC_FRONT_EXTERNAL_SCRIPT_VARIABLE_DATA');
  }

  return { adapter: cafe24Adapter, score, reason: reasons };
}

function scoreGodomall(url: string, html = ''): RouteCandidate {
  const reasons: string[] = [];
  let score = 0;
  const parsed = safeUrl(url);
  const host = parsed?.hostname ?? '';
  const urlSignals =
    url.includes('/goods/goods_list.php') || url.includes('/goods/goods_view.php');
  const htmlSignals = [
    'data-goods-nm',
    '/goods/goods_view.php',
    '/goods/goods_list.php',
    'goods_prd_item2_box',
    'goods_price',
    'godo',
  ].filter((marker) => html.includes(marker)).length;

  score = addIfMatch(reasons, score, urlSignals, 'godomall goods path', 40);
  score = addIfMatch(
    reasons,
    score,
    /(?:^|\.)godo(?:mall)?\./i.test(host),
    host || 'godo host',
    80,
  );
  if (htmlSignals > 0) {
    score += htmlSignals * 12;
    reasons.push(`${htmlSignals} godomall html signals`);
  }

  return { adapter: godomallAdapter, score, reason: reasons };
}

function scoreFirstmall(url: string, html = ''): RouteCandidate {
  const reasons: string[] = [];
  let score = 0;
  const parsed = safeUrl(url);
  const host = parsed?.hostname ?? '';

  score = addIfMatch(
    reasons,
    score,
    url.includes('/goods/catalog'),
    '/goods/catalog',
    100,
  );
  score = addIfMatch(
    reasons,
    score,
    html.includes('window.Firstmall'),
    'window.Firstmall',
    80,
  );
  score = addIfMatch(
    reasons,
    score,
    html.includes('/goods/goods_view.php') || html.includes('goods_seq'),
    'firstmall goods signals',
    20,
  );
  if (host && /firstmall/i.test(host)) {
    score += 20;
    reasons.push('firstmall host');
  }

  return { adapter: firstmallAdapter, score, reason: reasons };
}

function scoreWordPress(url: string, html = ''): RouteCandidate {
  const reasons: string[] = [];
  let score = 0;

  const markerScores: Array<[string, number]> = [
    ['wp-content', 35],
    ['wp-includes', 20],
    ['wp-json', 30],
    ['WordPress', 25],
    ['woocommerce', 30],
    ['woocommerce-loop-product__title', 20],
    ['elementor', 15],
    ['kboard', 15],
    ['mangboard', 15],
  ];

  for (const [marker, amount] of markerScores) {
    if (!html.includes(marker)) continue;
    reasons.push(marker);
    score += amount;
  }

  if (/<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*WordPress/i.test(html)) {
    score += 30;
    reasons.push('WordPress generator');
  }

  const parsed = safeUrl(url);
  if (parsed?.pathname.includes('/wp-json/')) {
    score += 20;
    reasons.push('wp-json path');
  }

  return { adapter: wordpressAdapter, score, reason: reasons };
}

export function selectAdapter(url: string, html?: string): RouteCandidate {
  const source = html ?? '';
  const candidates = [
    scoreNaverBrand(url, source),
    scoreNaverSmart(url, source),
    scoreHappyland(url, source),
    scoreNuxt(url, source),
    scoreWordPress(url, source),
    scoreGodomall(url, source),
    scoreFirstmall(url, source),
    scoreCafe24(url, source),
  ].filter((candidate) => candidate.score > 0);

  if (candidates.length === 0) {
    return { adapter: genericAdapter, score: 1, reason: ['fallback generic'] };
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

export async function crawlUniversal(
  url: string,
  onProgress?: (productName: string) => void,
): Promise<RawProduct[]> {
  let html: string | undefined;
  let resolvedUrl = url;
  try {
    const fetched = await fetchHtmlWithFallbackAndUrl(url);
    html = fetched.html;
    resolvedUrl = fetched.finalUrl || url;
  } catch {
    // Some URLs may not serve HTML; adapters fall back to URL-only detection.
  }

  const selected = selectAdapter(resolvedUrl, html);
  console.log(
    `[universal] selected ${selected.adapter.name} (score=${selected.score})`,
    selected.reason.join(', '),
  );
  return filterSoldOutProducts(await selected.adapter.crawl(resolvedUrl, onProgress));
}
