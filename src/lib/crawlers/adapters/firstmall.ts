import axios from 'axios';
import * as cheerio from 'cheerio';
import type { RawProduct } from '../../schemas/product';
import type { CrawlerAdapter } from './types';

const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

interface FirstmallGoodsInfo {
  goods_seq?: string | number;
  goods_name?: string;
  consumer_price?: string | number;
  price?: string | number;
  sale_price?: string | number;
  image?: string;
  category?: string;
}

function requestHeaders(origin: string): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Referer: `${origin}/`,
  };
}

function parsePrice(value: string | number | undefined): number {
  if (value === undefined || value === null) return 0;
  const parsed = parseFloat(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function resolveImageUrl(imagePath: string, origin: string): string {
  if (!imagePath) return '';
  if (imagePath.startsWith('http')) return imagePath;
  if (imagePath.startsWith('//')) return `https:${imagePath}`;
  return new URL(imagePath, `${origin}/`).href;
}

function parseGoodsInfo(raw: string): FirstmallGoodsInfo | null {
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    return JSON.parse(decoded) as FirstmallGoodsInfo;
  } catch {
    return null;
  }
}

async function discoverCategoryCodes(
  origin: string,
  html: string,
): Promise<string[]> {
  const $ = cheerio.load(html);
  const codes = new Set<string>();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') ?? '';
    try {
      const link = new URL(href, `${origin}/`);
      const code = link.searchParams.get('code');
      if (
        link.pathname === '/goods/catalog' &&
        code &&
        code.trim().length > 0
      ) {
        codes.add(code.trim());
      }
    } catch {
      // 잘못된 href 무시
    }
  });

  console.log(`[firstmall] discovered ${codes.size} category codes:`, [...codes]);
  return [...codes];
}

function parseProductsFromPage(
  html: string,
  origin: string,
): { products: RawProduct[]; fingerprint: string } {
  const $ = cheerio.load(html);
  const products: RawProduct[] = [];

  const goodsInfoElements = $('[goodsInfo]');
  console.log(`[firstmall] parseProductsFromPage: found ${goodsInfoElements.length} [goodsInfo] elements`);

  goodsInfoElements.each((_, element) => {
    const raw = $(element).attr('goodsInfo') ?? $(element).attr('goodsinfo');
    if (!raw) return;

    const info = parseGoodsInfo(raw);
    if (!info || !info.goods_name || !info.goods_seq) return;

    const salesPrice =
      parsePrice(info.sale_price) ||
      parsePrice(info.price);
    const consumerPrice =
      parsePrice(info.consumer_price) || salesPrice;

    if (!salesPrice) return;

    products.push({
      name: String(info.goods_name).trim(),
      image_url: resolveImageUrl(String(info.image ?? ''), origin),
      consumer_price: Math.max(consumerPrice, salesPrice),
      sales_price: salesPrice,
      category: info.category ? String(info.category).trim() : undefined,
      url: `${origin}/goods/goods_view.php?goodsNo=${encodeURIComponent(String(info.goods_seq))}`,
    });
  });

  const fingerprint = products.map((p) => p.url ?? p.name).join('');
  return { products, fingerprint };
}

async function crawlCategory(
  origin: string,
  code: string,
): Promise<RawProduct[]> {
  const all: RawProduct[] = [];
  let previousFingerprint = '';

  for (let page = 1; ; page += 1) {
    const url = new URL('/goods/catalog', origin);
    url.searchParams.set('code', code);
    url.searchParams.set('page', String(page));

    console.log(`[firstmall] fetching category ${code} page ${page}: ${url.href}`);
    let html: string;
    try {
      const response = await axios.get<string>(url.href, {
        headers: requestHeaders(origin),
      });
      html = response.data;
    } catch (error) {
      console.warn(`[firstmall] Category ${code} page ${page} failed:`, error);
      break;
    }

    const { products, fingerprint } = parseProductsFromPage(html, origin);
    console.log(`[firstmall] category ${code} page ${page}: ${products.length} products`);

    if (products.length === 0) break;
    if (fingerprint === previousFingerprint) break;

    all.push(...products);
    previousFingerprint = fingerprint;
  }

  console.log(`[firstmall] category ${code} total: ${all.length} products`);
  return all;
}

export const firstmallAdapter = {
  name: 'firstmall',

  detect(url: string, html?: string): boolean {
    if (html?.includes('window.Firstmall')) return true;
    try {
      return new URL(url).pathname === '/goods/catalog';
    } catch {
      return url.includes('/goods/catalog');
    }
  },

  async crawl(
    url: string,
    onProgress?: (productName: string) => void,
  ): Promise<RawProduct[]> {
    const origin = new URL(url).origin;
    console.log(`[firstmall] crawl start: ${origin}`);

    const homepageResponse = await axios.get<string>(origin, {
      headers: requestHeaders(origin),
    });
    const homepageHtml = homepageResponse.data;
    console.log(`[firstmall] homepage fetched (${homepageHtml.length} chars)`);

    const codes = await discoverCategoryCodes(origin, homepageHtml);
    const allProducts: RawProduct[] = [];

    if (codes.length === 0) {
      console.warn('[firstmall] No category codes found, trying homepage directly');
      const { products } = parseProductsFromPage(homepageHtml, origin);
      console.log(`[firstmall] homepage products: ${products.length}`);
      for (const p of products) onProgress?.(p.name);
      return products;
    }

    const seenSeqs = new Set<string>();

    for (const code of codes) {
      const products = await crawlCategory(origin, code);
      for (const product of products) {
        const key = product.url ?? product.name;
        if (seenSeqs.has(key)) continue;
        seenSeqs.add(key);
        allProducts.push(product);
        onProgress?.(product.name);
      }
    }

    console.log(`[firstmall] crawl done: ${allProducts.length} total products`);
    return allProducts;
  },
} satisfies CrawlerAdapter;
