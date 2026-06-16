import axios from 'axios';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { chromium } from 'playwright';
import type { RawProduct } from '../../schemas/product';
import { fetchHtmlWithFallback, parsePrice } from '../utils';
import { filterSoldOutProducts } from '../sold-out';
import type { CrawlerAdapter } from './types';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_API_PAGES = 10;
const MAX_HTML_PAGES = 20;
const API_PAGE_SIZE = 100;

const API_ENDPOINTS = [
  '/wp-json/wc/store/products',
  '/wp-json/wc/v3/products',
  '/wp-json/wc/v2/products',
  '/wp-json/wp/v2/product',
] as const;

const WORDPRESS_MARKERS = [
  'wp-content',
  'wp-includes',
  'wp-json',
  'WordPress',
  'woocommerce',
  'woocommerce-loop-product__title',
  'elementor',
  'kboard',
  'mangboard',
] as const;

const STOREFRONT_HOST_MARKERS = [
  /(?:^|\.)cafe24\.com$/i,
  /(?:^|\.)cafe24shop\.com$/i,
  /(?:^|\.)mycafe24\.com$/i,
  /(?:^|\.)smartstore\.naver\.com$/i,
  /(?:^|\.)brand\.naver\.com$/i,
  /(?:^|\.)godo(?:mall)?\./i,
  /firstmall/i,
];

function requestHeaders(origin: string): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Referer: `${origin}/`,
    Accept: 'application/json, text/plain, */*',
  };
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function absoluteUrl(value: string, baseUrl: string): string {
  if (!value) return '';
  if (value.startsWith('//')) return `https:${value}`;

  try {
    return new URL(value, baseUrl).href;
  } catch {
    return '';
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function textFromElement(element: cheerio.Cheerio<AnyNode>): string {
  return cleanText(
    element.attr('aria-label')?.trim() ||
      element.attr('title')?.trim() ||
      element.text(),
  );
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, ' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function firstText(
  product: cheerio.Cheerio<AnyNode>,
  selectors: readonly string[],
): string {
  for (const selector of selectors) {
    const text = cleanText(product.find(selector).first().text());
    if (text) return text;
  }
  return '';
}

function firstAttr(
  product: cheerio.Cheerio<AnyNode>,
  selector: string,
  attributes: readonly string[],
): string {
  const element = product.find(selector).first();
  for (const attribute of attributes) {
    const value = element.attr(attribute)?.trim();
    if (value) return value;
  }
  return '';
}

function firstMetaContent(
  $: cheerio.CheerioAPI,
  selectors: readonly string[],
): string {
  for (const selector of selectors) {
    const value = $(selector).first().attr('content')?.trim();
    if (value) return value;
  }
  return '';
}

function normalizeProduct(product: RawProduct, baseUrl: string): RawProduct {
  return {
    ...product,
    name: cleanText(product.name),
    image_url: absoluteUrl(product.image_url, baseUrl),
    consumer_price: parsePrice(String(product.consumer_price)),
    sales_price: parsePrice(String(product.sales_price)),
    description: product.description ? cleanText(product.description) : undefined,
    category: product.category ? cleanText(product.category) : undefined,
    url: product.url ? absoluteUrl(product.url, baseUrl) : undefined,
  };
}

function normalizeProducts(products: RawProduct[], baseUrl: string): RawProduct[] {
  const seen = new Set<string>();
  const normalized: RawProduct[] = [];

  for (const product of products) {
    const next = normalizeProduct(product, baseUrl);
    if (!next.name || !next.sales_price || !next.image_url) continue;

    const key = [
      next.name.toLowerCase(),
      next.url ?? '',
      next.sales_price,
      next.image_url,
    ].join('\u0000');
    if (seen.has(key)) continue;

    seen.add(key);
    normalized.push(next);
  }

  return filterSoldOutProducts(normalized);
}

function pickPrice(...values: unknown[]): number {
  for (const value of values) {
    const price = parsePrice(value as string | number);
    if (price > 0) return price;
  }
  return 0;
}

function pickImageFromApi(item: Record<string, unknown>): string {
  const images = Array.isArray(item.images) ? item.images : [];
  const firstImage = images.find(isRecord);
  const yoast = isRecord(item.yoast_head_json) ? item.yoast_head_json : undefined;
  const ogImages = yoast && Array.isArray(yoast.og_image) ? yoast.og_image : [];
  const ogImage = ogImages.find(isRecord);

  return (
    stringValue(item.image) ||
    stringValue(item.featured_media_url) ||
    stringValue(item.jetpack_featured_media_url) ||
    stringValue(firstImage?.src) ||
    stringValue(ogImage?.url)
  );
}

function pickNameFromApi(item: Record<string, unknown>): string {
  const title = isRecord(item.title) ? stringValue(item.title.rendered) : '';
  const excerpt = isRecord(item.excerpt) ? stringValue(item.excerpt.rendered) : '';
  return cleanText(
    stripTags(
      stringValue(item.name) ||
        title ||
        stringValue(item.post_title) ||
        excerpt ||
        stringValue(item.slug),
    ),
  );
}

function pickDescriptionFromApi(item: Record<string, unknown>): string {
  const excerpt = isRecord(item.excerpt) ? stringValue(item.excerpt.rendered) : '';
  const content = isRecord(item.content) ? stringValue(item.content.rendered) : '';
  return cleanText(stripTags(stringValue(item.short_description) || excerpt || content));
}

function pickUrlFromApi(item: Record<string, unknown>): string {
  return (
    stringValue(item.permalink) ||
    stringValue(item.link) ||
    stringValue(item.url) ||
    (isRecord(item.guid) ? stringValue(item.guid.rendered) : '')
  );
}

function pickCategoryFromApi(item: Record<string, unknown>): string {
  if (Array.isArray(item.categories)) {
    return item.categories
      .filter((category): category is Record<string, unknown> => isRecord(category))
      .map((category) => stringValue(category.name))
      .filter(Boolean)
      .join(', ');
  }

  if (Array.isArray(item.tags)) {
    return item.tags
      .filter((tag): tag is Record<string, unknown> => isRecord(tag))
      .map((tag) => stringValue(tag.name))
      .filter(Boolean)
      .join(', ');
  }

  return '';
}

function pickSalesPriceFromApi(item: Record<string, unknown>): number {
  const meta = isRecord(item.meta) ? item.meta : undefined;
  const prices = isRecord(item.prices) ? item.prices : undefined;

  return pickPrice(
    stringValue(item.sale_price),
    stringValue(item.price),
    stringValue(item.amount),
    stringValue(item._sale_price),
    meta ? meta.sale_price : undefined,
    meta ? meta.price : undefined,
    meta ? meta._sale_price : undefined,
    meta ? meta._price : undefined,
    prices ? prices.sale_price : undefined,
    prices ? prices.price : undefined,
  );
}

function pickConsumerPriceFromApi(item: Record<string, unknown>, salesPrice: number): number {
  const meta = isRecord(item.meta) ? item.meta : undefined;
  const prices = isRecord(item.prices) ? item.prices : undefined;

  return (
    pickPrice(
      stringValue(item.regular_price),
      stringValue(item.price_regular),
      stringValue(item.compare_at_price),
      stringValue(item._regular_price),
      meta ? meta.regular_price : undefined,
      meta ? meta._regular_price : undefined,
      prices ? prices.regular_price : undefined,
      prices ? prices.compare_at_price : undefined,
    ) || salesPrice
  );
}

function parseApiItem(item: unknown, baseUrl: string): RawProduct | null {
  if (!isRecord(item)) return null;

  const name = pickNameFromApi(item);
  const salesPrice = pickSalesPriceFromApi(item);
  const consumerPrice = pickConsumerPriceFromApi(item, salesPrice);
  const imageUrl = pickImageFromApi(item);
  const url = pickUrlFromApi(item);

  if (!name || !salesPrice || !imageUrl) return null;

  return normalizeProduct(
    {
      name,
      image_url: imageUrl,
      consumer_price: Math.max(consumerPrice, salesPrice),
      sales_price: salesPrice,
      description: pickDescriptionFromApi(item) || undefined,
      category: pickCategoryFromApi(item) || undefined,
      url: url || undefined,
    },
    baseUrl,
  );
}

function parseApiResponse(data: unknown, baseUrl: string): RawProduct[] {
  const items: unknown[] = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.products)
      ? data.products
      : isRecord(data) && Array.isArray(data.data)
        ? data.data
        : [];

  return normalizeProducts(
    items.map((item) => parseApiItem(item, baseUrl)).filter((item): item is RawProduct => Boolean(item)),
    baseUrl,
  );
}

async function fetchApiPage(
  endpoint: string,
  origin: string,
  page: number,
): Promise<{ products: RawProduct[]; totalPages?: number } | null> {
  const response = await axios.get<unknown>(endpoint, {
    headers: requestHeaders(origin),
    params: {
      page,
      per_page: API_PAGE_SIZE,
    },
    timeout: 15000,
    validateStatus: (status) => status >= 200 && status < 500,
  });

  if (response.status !== 200) return null;

  const totalPagesValue = response.headers['x-wp-totalpages'];
  const totalPages = Number(Array.isArray(totalPagesValue) ? totalPagesValue[0] : totalPagesValue);

  return {
    products: parseApiResponse(response.data, origin),
    totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : undefined,
  };
}

async function crawlApi(origin: string, onProgress?: (productName: string) => void): Promise<RawProduct[]> {
  const collected: RawProduct[] = [];
  const seen = new Set<string>();

  for (const path of API_ENDPOINTS) {
    const endpoint = new URL(path, origin).href;

    for (let page = 1; page <= MAX_API_PAGES; page += 1) {
      try {
        const result = await fetchApiPage(endpoint, origin, page);
        if (!result || result.products.length === 0) break;

        const { products, totalPages } = result;
        console.log(
          `[wordpress] API ${path} page ${page}: ${products.length} products`,
        );

        for (const product of products) {
          const key = [
            product.name.toLowerCase(),
            product.url ?? '',
            product.sales_price,
            product.image_url,
          ].join('\u0000');
          if (seen.has(key)) continue;

          seen.add(key);
          collected.push(product);
          onProgress?.(product.name);
        }

        if (products.length < API_PAGE_SIZE) break;
        if (totalPages && page >= totalPages) break;
      } catch (error) {
        console.warn(`[wordpress] API ${path} page ${page} failed:`, error);
        break;
      }
    }

    if (collected.length > 0) {
      return collected;
    }
  }

  return collected;
}

function parseListingProducts(html: string, pageUrl: string): RawProduct[] {
  const $ = cheerio.load(html);
  const products: RawProduct[] = [];
  const selectors = [
    'ul.products li.product',
    '.woocommerce ul.products li.product',
    'article.product',
    'li.product',
    '.product-item',
    '.product-card',
    '[class*=product][class*=item]',
    '[class*=product]',
  ];

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const product = $(element);
      const name = firstText(product, [
        '.woocommerce-loop-product__title',
        '.product-title',
        '[class*=title]',
        '[class*=name]',
        'h2',
        'h3',
        'a[title]',
      ]) || cleanText(product.attr('aria-label') ?? '');
      const priceText = firstText(product, [
        '.woocommerce-Price-amount',
        '.price',
        '[class*=price]',
      ]);
      const imageUrl = firstAttr(product, 'img', [
        'src',
        'data-src',
        'data-lazy-src',
        'data-original',
        'srcset',
      ]).split(/\s+/)[0];
      const productUrl = firstAttr(product, 'a[href]', ['href']);
      const nameAttr = product.attr('data-product-name')?.trim() ?? '';
      const prices = [
        ...product
          .find('.woocommerce-Price-amount, .price, [class*=price]')
          .toArray()
          .map((element) => parsePrice(cleanText($(element).text()))),
        parsePrice(priceText),
      ].filter((value) => value > 0);

      const salesPrice = prices.length > 0 ? Math.min(...prices) : 0;
      const consumerPrice = prices.length > 0 ? Math.max(...prices) : 0;

      const candidate = {
        name: name || nameAttr,
        image_url: imageUrl,
        consumer_price: consumerPrice || salesPrice,
        sales_price: salesPrice,
        url: productUrl || undefined,
      };

      if (candidate.name && candidate.sales_price > 0 && candidate.image_url) {
        products.push(candidate);
      }
    });
  }

  return normalizeProducts(products, pageUrl);
}

type LinkCandidate = {
  url: string;
  score: number;
  reason: string[];
};

function scoreStorefrontLink(href: string, text: string, pageUrl: string): LinkCandidate | null {
  const url = absoluteUrl(href, pageUrl);
  if (!url) return null;

  const parsed = safeUrl(url);
  const host = parsed?.hostname ?? '';
  const pathname = parsed?.pathname.toLowerCase() ?? '';
  const combined = `${text} ${href}`.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  for (const marker of STOREFRONT_HOST_MARKERS) {
    if (!marker.test(host)) continue;
    score += 100;
    reasons.push(host || 'store host');
    break;
  }

  if (
    /쇼핑몰|쇼핑|상품|자세히보기|구매|스토어|입점|브랜드|shop|store|mall/i.test(combined)
  ) {
    score += 30;
    reasons.push('shopping text');
  }

  if (/\/(shop|store|mall|product|goods|category|collections|item)\b/i.test(pathname)) {
    score += 40;
    reasons.push(pathname);
  }

  if (score === 0) return null;

  return { url, score, reason: reasons };
}

function discoverStorefrontLinks(html: string, pageUrl: string): LinkCandidate[] {
  const $ = cheerio.load(html);
  const candidates = new Map<string, LinkCandidate>();

  $('a[href]').each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr('href')?.trim() ?? '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

    const candidate = scoreStorefrontLink(href, textFromElement(anchor), pageUrl);
    if (!candidate) return;

    const existing = candidates.get(candidate.url);
    if (!existing || candidate.score > existing.score) {
      candidates.set(candidate.url, candidate);
    }
  });

  return [...candidates.values()].sort((a, b) => b.score - a.score);
}

function parseDetailProduct(html: string, pageUrl: string): RawProduct[] {
  const $ = cheerio.load(html);
  const name = cleanText(
    stripTags(
      firstMetaContent($, [
        'meta[property="og:title"]',
        'meta[name="title"]',
        'meta[property="twitter:title"]',
      ]) ||
        $('h1').first().text() ||
        $('h2').first().text() ||
        $('[class*=product-title]').first().text() ||
        $('[class*=title]').first().text(),
    ),
  );

  const imageUrl =
    absoluteUrl(
      firstMetaContent($, [
        'meta[property="og:image"]',
        'meta[property="product:image"]',
        'meta[property="twitter:image"]',
      ]),
      pageUrl,
    ) || $('img').first().attr('src')?.trim() || '';

  const salesPrice =
    pickPrice(
      firstMetaContent($, [
        'meta[property="product:price:amount"]',
        'meta[property="og:price:amount"]',
        'meta[name="product_price"]',
        'meta[itemprop="price"]',
      ]),
    ) ||
    parsePrice(
      cleanText(
        $('.price').first().text() ||
          $('[class*=price]').first().text() ||
          $('strong').first().text(),
      ),
    );

  if (!name || !salesPrice) return [];

  const consumerPrice =
    pickPrice(
      firstMetaContent($, [
        'meta[property="product:original_price:amount"]',
        'meta[name="original_price"]',
      ]),
    ) || salesPrice;

  return normalizeProducts(
    [
      {
        name,
        image_url: imageUrl,
        consumer_price: Math.max(consumerPrice, salesPrice),
        sales_price: salesPrice,
        description: cleanText(
          stripTags(
            firstMetaContent($, ['meta[name="description"]']) ||
              $('[class*=desc]').first().text(),
          ),
        ),
        url: pageUrl,
      },
    ],
    pageUrl,
  );
}

function detectNextPageUrl(html: string, pageUrl: string): string {
  const $ = cheerio.load(html);
  const candidates = [
    $('link[rel="next"]').first().attr('href'),
    $('a[rel="next"]').first().attr('href'),
    $('a.next.page-numbers').first().attr('href'),
    $('a.page-numbers.next').first().attr('href'),
    $('a.next').first().attr('href'),
  ];

  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    const resolved = absoluteUrl(value, pageUrl);
    if (resolved && resolved !== pageUrl) return resolved;
  }

  return '';
}

function isLikelyDetailPage(html: string, pageUrl: string): boolean {
  const $ = cheerio.load(html);
  const pathname = safeUrl(pageUrl)?.pathname.toLowerCase() ?? '';

  return (
    pathname.includes('/product/') ||
    pathname.includes('/item/') ||
    pathname.includes('/goods/') ||
    firstMetaContent($, ['meta[property="og:type"]']).toLowerCase() === 'product' ||
    firstMetaContent($, ['meta[property="product:price:amount"]']) !== '' ||
    firstMetaContent($, ['meta[property="product:original_price:amount"]']) !== ''
  );
}

async function crawlHtml(
  url: string,
  initialHtml: string,
  onProgress?: (productName: string) => void,
): Promise<RawProduct[]> {
  const collected: RawProduct[] = [];
  const seen = new Set<string>();
  const visitedUrls = new Set<string>([url]);
  let currentUrl = url;
  let html = initialHtml;

  for (let page = 1; page <= MAX_HTML_PAGES; page += 1) {
    console.log(`[wordpress] HTML page ${page}: ${currentUrl}`);
    const detailProducts = isLikelyDetailPage(html, currentUrl)
      ? parseDetailProduct(html, currentUrl)
      : [];
    const products = detailProducts.length > 0 ? detailProducts : parseListingProducts(html, currentUrl);

    for (const product of products) {
      const key = [
        product.name.toLowerCase(),
        product.url ?? '',
        product.sales_price,
        product.image_url,
      ].join('\u0000');
      if (seen.has(key)) continue;

      seen.add(key);
      collected.push(product);
      onProgress?.(product.name);
    }

    const nextUrl = detectNextPageUrl(html, currentUrl);
    if (!nextUrl) break;
    if (visitedUrls.has(nextUrl)) break;

    visitedUrls.add(nextUrl);
    currentUrl = nextUrl;
    try {
      html = await fetchHtmlWithFallback(currentUrl, { referer: currentUrl });
    } catch (error) {
      console.warn(`[wordpress] HTML page ${page + 1} failed:`, error);
      break;
    }
  }

  return collected;
}

async function crawlRenderedHtml(
  url: string,
  onProgress?: (productName: string) => void,
): Promise<{ products: RawProduct[]; html: string }> {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  });

  try {
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html = await page.content();
    console.log(`[wordpress] rendered HTML (${html.length} chars)`);
    const products = await crawlHtml(url, html, onProgress);
    return { products, html };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function crawlLinkedStorefronts(
  pageUrl: string,
  html: string,
  onProgress: ((productName: string) => void) | undefined,
  visited: Set<string>,
  depth: number,
): Promise<RawProduct[]> {
  if (depth >= 2) return [];

  const links = discoverStorefrontLinks(html, pageUrl);
  if (links.length === 0) return [];

  const { selectAdapter } = await import('../universal');

  for (const link of links.slice(0, 8)) {
    if (visited.has(link.url)) continue;
    visited.add(link.url);

    console.log(
      `[wordpress] following link ${link.url} (${link.reason.join(', ') || 'store link'})`,
    );

    try {
      const linkedHtml = await fetchHtmlWithFallback(link.url, { referer: pageUrl });
      const selected = selectAdapter(link.url, linkedHtml);
      console.log(
        `[wordpress] link selected ${selected.adapter.name} (score=${selected.score})`,
        selected.reason.join(', '),
      );

      if (selected.adapter.name === 'wordpress') {
        const nested = await crawlWordPress(
          link.url,
          onProgress,
          depth + 1,
          visited,
          linkedHtml,
        );
        if (nested.length > 0) return nested;
        continue;
      }

      const products = await selected.adapter.crawl(link.url, onProgress);
      if (products.length > 0) return products;
    } catch (error) {
      console.warn(`[wordpress] linked crawl failed for ${link.url}:`, error);
    }
  }

  return [];
}

async function crawlWordPress(
  url: string,
  onProgress?: (productName: string) => void,
  depth = 0,
  visited: Set<string> = new Set<string>(),
  initialHtml = '',
): Promise<RawProduct[]> {
  const origin = new URL(url).origin;
  const normalizedUrl = new URL(url).href;
  visited.add(normalizedUrl);

  console.log(`[wordpress] crawl start: ${origin} depth=${depth}`);

  try {
    const apiProducts = await crawlApi(origin, onProgress);
    if (apiProducts.length > 0) {
      console.log(`[wordpress] API crawl done: ${apiProducts.length} products`);
      return apiProducts;
    }
  } catch (error) {
    console.warn('[wordpress] API crawl failed:', error);
  }

  let html = initialHtml;
  if (!html) {
    try {
      html = await fetchHtmlWithFallback(url, { referer: `${origin}/` });
      console.log(`[wordpress] page fetched (${html.length} chars)`);
    } catch (error) {
      console.warn('[wordpress] HTML fetch failed:', error);
    }
  }

  if (html) {
    const htmlProducts = await crawlHtml(url, html, onProgress);
    if (htmlProducts.length > 0) {
      console.log(`[wordpress] HTML crawl done: ${htmlProducts.length} products`);
      return htmlProducts;
    }

    const linkedProducts = await crawlLinkedStorefronts(
      url,
      html,
      onProgress,
      visited,
      depth,
    );
    if (linkedProducts.length > 0) {
      return linkedProducts;
    }
  }

  try {
    const rendered = await crawlRenderedHtml(url, onProgress);
    if (rendered.products.length > 0) {
      console.log(
        `[wordpress] rendered crawl done: ${rendered.products.length} products`,
      );
      return rendered.products;
    }

    const linkedProducts = await crawlLinkedStorefronts(
      url,
      rendered.html,
      onProgress,
      visited,
      depth,
    );
    if (linkedProducts.length > 0) {
      return linkedProducts;
    }
  } catch (error) {
    console.warn('[wordpress] rendered crawl failed:', error);
  }

  return [];
}

export const wordpressAdapter = {
  name: 'wordpress',

  detect(_url: string, html?: string): boolean {
    if (!html) return false;

    return (
      WORDPRESS_MARKERS.some((marker) => html.includes(marker)) ||
      /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*WordPress/i.test(html)
    );
  },

  async crawl(
    url: string,
    onProgress?: (productName: string) => void,
  ): Promise<RawProduct[]> {
    return crawlWordPress(url, onProgress);
  },
} satisfies CrawlerAdapter;
