import axios from 'axios';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { RawProduct } from '../../schemas/product';
import { filterSoldOutProducts } from '../sold-out';
import type { CrawlerAdapter } from './types';

const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const DETAIL_CONCURRENCY = 10;

interface FirstmallGoodsInfo {
  goods_seq?: string | number;
  goods_name?: string;
  consumer_price?: string | number;
  price?: string | number;
  sale_price?: string | number;
  image?: string;
  category?: string;
}

type ListedProduct = RawProduct & {
  goodsNo: string;
};

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

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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
      if (link.pathname === '/goods/catalog' && code?.trim()) {
        codes.add(code.trim());
      }
    } catch {
      // ignore malformed links
    }
  });

  console.log(`[firstmall] discovered ${codes.size} category codes:`, [...codes]);
  return [...codes];
}

function isPlaceholderOption(value: string): boolean {
  return /^(?:-+|\*+|(?:\uC120\uD0DD|\uC635\uC158\uC120\uD0DD|\uC0C1\uD488\uC635\uC158\uC744\s*\uC120\uD0DD\uD574\s*\uC8FC\uC138\uC694)|choose|select|required)$/i.test(
    value,
  );
}

function optionLabel(
  $: cheerio.CheerioAPI,
  element: cheerio.Cheerio<AnyNode>,
): string {
  const explicitLabel =
    element.attr('option_title') ||
    element.attr('data-option_title') ||
    element.attr('data-option-name');
  if (explicitLabel?.trim()) return cleanText(explicitLabel);

  const id = element.attr('id') ?? '';
  const associatedLabel = id ? $(`label[for="${id}"]`).first().text().trim() : '';
  if (associatedLabel) return cleanText(associatedLabel);

  const rowLabel = element
    .closest('tr')
    .find('th.optionTitle, th, dt, label, .title')
    .first()
    .text()
    .trim();
  if (rowLabel) return cleanText(rowLabel);

  return '';
}

function parseOptions(html: string): string[] {
  const $ = cheerio.load(html);
  const options: string[] = [];

  $('select').each((_, element) => {
    const select = $(element);
    const name = select.attr('name') ?? '';
    const id = select.attr('id') ?? '';
    const looksLikeOptionSelect =
      /^viewOptions/i.test(name) ||
      /option|goods_option|viewOptions/i.test(name) ||
      /option|goods_option/i.test(id) ||
      select.closest('tr').hasClass('optionTr') ||
      select.attr('option_title') !== undefined ||
      select.attr('data-option_title') !== undefined ||
      select.attr('data-option-name') !== undefined;

    if (!looksLikeOptionSelect) return;

    const values = select
      .find('option')
      .map((_, option) => {
        const opt = $(option);
        const text = cleanText(opt.text());
        const value = cleanText(opt.attr('value') ?? '');
        return text || value;
      })
      .get()
      .filter((value) => value.length > 0 && !isPlaceholderOption(value));

    if (values.length === 0) return;

    const label = optionLabel($, select) || `옵션${options.length + 1}`;
    options.push(`${label}: ${[...new Set(values)].join(', ')}`);
  });

  return options;
}

function parseProductsFromPage(
  html: string,
  origin: string,
): { products: ListedProduct[]; fingerprint: string } {
  const $ = cheerio.load(html);
  const products: ListedProduct[] = [];

  const goodsInfoElements = $('[goodsInfo]');
  console.log(
    `[firstmall] parseProductsFromPage: found ${goodsInfoElements.length} [goodsInfo] elements`,
  );

  goodsInfoElements.each((_, element) => {
    const raw = $(element).attr('goodsInfo') ?? $(element).attr('goodsinfo');
    if (!raw) return;

    const info = parseGoodsInfo(raw);
    if (!info || !info.goods_name || !info.goods_seq) return;

    const salesPrice = parsePrice(info.sale_price) || parsePrice(info.price);
    const consumerPrice = parsePrice(info.consumer_price) || salesPrice;

    if (!salesPrice) return;

    products.push({
      goodsNo: String(info.goods_seq),
      name: String(info.goods_name).trim(),
      image_url: resolveImageUrl(String(info.image ?? ''), origin),
      consumer_price: Math.max(consumerPrice, salesPrice),
      sales_price: salesPrice,
      category: info.category ? String(info.category).trim() : undefined,
      url: `${origin}/goods/view?no=${encodeURIComponent(String(info.goods_seq))}`,
    });
  });

  const fingerprint = products.map((p) => p.url ?? p.name).join('');
  return { products, fingerprint };
}

async function fetchProductOptions(
  origin: string,
  goodsNo: string,
): Promise<string[]> {
  if (!goodsNo) return [];

  try {
    const detailUrl = `${origin}/goods/view?no=${encodeURIComponent(goodsNo)}`;
    const response = await axios.get<string>(detailUrl, {
      headers: requestHeaders(origin),
      timeout: 15000,
    });
    return parseOptions(response.data);
  } catch (error) {
    console.warn(`[firstmall] Detail request failed for goodsNo ${goodsNo}:`, error);
    return [];
  }
}

async function enrichWithOptions(
  origin: string,
  products: ListedProduct[],
): Promise<RawProduct[]> {
  const { default: pLimit } = await import('p-limit');
  const limit = pLimit(DETAIL_CONCURRENCY);

  return Promise.all(
    products.map((listedProduct) =>
      limit(async () => {
        const { goodsNo, ...product } = listedProduct;
        return {
          ...product,
          options: await fetchProductOptions(origin, goodsNo),
        } as RawProduct;
      }),
    ),
  );
}

async function crawlCategory(
  origin: string,
  code: string,
): Promise<ListedProduct[]> {
  const all: ListedProduct[] = [];
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

    if (codes.length === 0) {
      console.warn('[firstmall] No category codes found, trying homepage directly');
      const { products } = parseProductsFromPage(homepageHtml, origin);
      console.log(`[firstmall] homepage products: ${products.length}`);
      const enriched = filterSoldOutProducts(await enrichWithOptions(origin, products));
      for (const product of enriched) onProgress?.(product.name);
      return enriched;
    }

    const seenSeqs = new Set<string>();
    const allProducts: ListedProduct[] = [];

    for (const code of codes) {
      const products = await crawlCategory(origin, code);
      for (const product of products) {
        const key = product.goodsNo || product.url || product.name;
        if (seenSeqs.has(key)) continue;
        seenSeqs.add(key);
        allProducts.push(product);
      }
    }

    const enriched = filterSoldOutProducts(await enrichWithOptions(origin, allProducts));
    for (const product of enriched) onProgress?.(product.name);

    console.log(`[firstmall] crawl done: ${enriched.length} total products`);
    return enriched;
  },
} satisfies CrawlerAdapter;
