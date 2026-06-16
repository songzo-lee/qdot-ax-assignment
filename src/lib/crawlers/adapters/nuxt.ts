import axios from 'axios';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { RawProduct } from '../../schemas/product';
import { fetchHtmlWithFallbackAndUrl, getBrowser, parsePrice } from '../utils';
import { filterSoldOutProducts } from '../sold-out';
import type { CrawlerAdapter } from './types';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MIN_PRODUCTS = 3;
const MAX_BUNDLE_SOURCES = 3;
const MAX_API_SOURCES = 20;
const MAX_CAPTURED_RESPONSES = 20;
const DETAIL_CONCURRENCY = 5;
const RENDER_WAIT_MS = 2500;

const CARD_SELECTORS = [
  '[role="listitem"]',
  '[data-product-id]',
  '[data-product-no]',
  '[data-goods-no]',
  '.product-item',
  '.product-card',
  '.product',
  '.goods',
  '.item',
  '[class*=product]',
  '[class*=goods]',
] as const;

const PRODUCT_NAME_KEYS = [
  'name',
  'title',
  'productName',
  'goods_nm',
  'goodsName',
  'prdNm',
  'product_nm',
  'displayName',
  'subject',
] as const;

const PRODUCT_PRICE_KEYS = [
  'sale_price',
  'sales_price',
  'price',
  'current_price',
  'discount_price',
  'salePrice',
  'selling_price',
  'product_price',
] as const;

const PRODUCT_CONSUMER_PRICE_KEYS = [
  'consumer_price',
  'compare_at_price',
  'regular_price',
  'original_price',
  'origin_price',
  'normal_price',
  'list_price',
] as const;

const PRODUCT_IMAGE_KEYS = [
  'image',
  'imageUrl',
  'image_url',
  'thumbnail',
  'thumb',
  'mainImage',
  'img',
  'goods_image',
  'goodsImage',
] as const;

const PRODUCT_URL_KEYS = [
  'url',
  'link',
  'href',
  'detailUrl',
  'productUrl',
  'permalink',
  'path',
] as const;

const PRODUCT_DESCRIPTION_KEYS = [
  'description',
  'short_description',
  'summary',
  'content',
  'desc',
] as const;

const PRODUCT_CATEGORY_KEYS = [
  'category',
  'categoryName',
  'cate_nm',
  'cateName',
] as const;

const OPTION_SKIP_RE = /^(?:select|choose|option|all|default)$/i;
const TWO_LEVEL_SUFFIXES = new Set([
  'co.kr',
  'or.kr',
  'go.kr',
  'ac.kr',
  'ne.kr',
  're.kr',
  'pe.kr',
  'co.jp',
  'ne.jp',
  'or.jp',
  'com.cn',
  'net.cn',
  'org.cn',
  'com.au',
  'net.au',
  'org.au',
  'co.uk',
  'org.uk',
  'gov.uk',
]);

function requestHeaders(origin: string): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Referer: `${origin}/`,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function firstString(
  item: Record<string, unknown>,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const text = stringValue(item[key]);
    if (text) return cleanText(text);
  }
  return '';
}

function firstPositive(...values: unknown[]): number {
  for (const value of values) {
    const parsed = parsePrice(stringValue(value));
    if (parsed > 0) return parsed;
  }
  return 0;
}

function findPriceText(value: string): string {
  const match = value.match(
    /(?:₩\s*\d[\d,]*|\d[\d,]*\s*원|\d[\d,]*(?:\.\d+)?\s*(?:won|krw))/i,
  );
  return match?.[0] ?? '';
}

function rootDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');

  const lastTwo = parts.slice(-2).join('.');
  if (TWO_LEVEL_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }

  return lastTwo;
}

function isRelatedHost(candidateHost: string, originHost: string): boolean {
  if (!candidateHost || !originHost) return false;
  if (candidateHost === originHost) return true;
  if (candidateHost.endsWith(`.${originHost}`)) return true;
  if (originHost.endsWith(`.${candidateHost}`)) return true;
  return rootDomain(candidateHost) === rootDomain(originHost);
}

function isNuxtBundleUrl(url: string): boolean {
  const parsed = safeUrl(url);
  if (!parsed) return false;
  return parsed.pathname.includes('/_nuxt/') && parsed.pathname.endsWith('.js');
}

function isLikelyDataEndpoint(url: string): boolean {
  const parsed = safeUrl(url);
  if (!parsed) return false;

  const path = parsed.pathname.toLowerCase();
  const search = parsed.search.toLowerCase();
  return (
    path.endsWith('.json') ||
    path.includes('/api/') ||
    /(?:^|\/)(?:product|products|goods|search|searches|display|catalog|category|item|list|detail|graphql)(?:\/|\.|$)/i.test(
      path,
    ) ||
    /(?:[?&])(?:cate|category|product|goods|page|search|keyword|sort|limit|offset)=/i.test(
      search,
    )
  );
}

function collectUrlsFromText(
  text: string,
  baseUrl: string,
  originHost: string,
): string[] {
  const matches = text.match(/(?:https?:\/\/|\/\/|\/)[^"'`<>\s\\]+/g) ?? [];
  const candidates = new Set<string>();

  for (const match of matches) {
    const candidate = absoluteUrl(match, baseUrl);
    if (!candidate) continue;

    const parsed = safeUrl(candidate);
    if (!parsed) continue;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;

    if (
      parsed.hostname &&
      !isRelatedHost(parsed.hostname, originHost) &&
      !parsed.hostname.includes('cdn') &&
      !parsed.hostname.includes('cloudfront')
    ) {
      continue;
    }

    if (
      isLikelyDataEndpoint(candidate) ||
      isNuxtBundleUrl(candidate) ||
      parsed.pathname.endsWith('.json')
    ) {
      candidates.add(parsed.href);
    }
  }

  return [...candidates];
}

function collectUrlsFromHtml(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const originHost = new URL(baseUrl).hostname;
  const candidates = new Set<string>();

  $('script[src], link[href], iframe[src], source[src], img[src]').each(
    (_, element) => {
      const source =
        $(element).attr('src') ||
        $(element).attr('href') ||
        $(element).attr('data-src') ||
        $(element).attr('content') ||
        '';
      const candidate = absoluteUrl(source, baseUrl);
      if (!candidate) return;

      const parsed = safeUrl(candidate);
      if (!parsed) return;

      if (
        parsed.hostname &&
        !isRelatedHost(parsed.hostname, originHost) &&
        !parsed.hostname.includes('cdn') &&
        !parsed.hostname.includes('cloudfront')
      ) {
        return;
      }

      if (isNuxtBundleUrl(candidate) || isLikelyDataEndpoint(candidate)) {
        candidates.add(parsed.href);
      }
    },
  );

  for (const candidate of collectUrlsFromText(html, baseUrl, originHost)) {
    candidates.add(candidate);
  }

  return [...candidates];
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

function extractImageUrl(value: unknown, baseUrl: string): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return absoluteUrl(String(value), baseUrl);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractImageUrl(item, baseUrl);
      if (url) return url;
    }
    return '';
  }

  if (isRecord(value)) {
    for (const key of ['src', 'url', 'image', 'imageUrl', 'image_url', 'thumbnail', 'thumb']) {
      const url = extractImageUrl(value[key], baseUrl);
      if (url) return url;
    }
  }

  return '';
}

function extractUrl(value: unknown, baseUrl: string): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return absoluteUrl(String(value), baseUrl);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractUrl(item, baseUrl);
      if (url) return url;
    }
    return '';
  }

  if (isRecord(value)) {
    for (const key of ['href', 'url', 'link', 'path', 'productUrl', 'detailUrl']) {
      const url = extractUrl(value[key], baseUrl);
      if (url) return url;
    }
  }

  return '';
}

function extractOptionsFromValue(
  value: unknown,
  collected = new Set<string>(),
  depth = 0,
): string[] {
  if (!value || depth > 5) return [...collected];

  if (typeof value === 'string' || typeof value === 'number') {
    const text = cleanText(String(value));
    if (text && !OPTION_SKIP_RE.test(text)) collected.add(text);
    return [...collected];
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractOptionsFromValue(item, collected, depth + 1);
    }
    return [...collected];
  }

  if (!isRecord(value)) return [...collected];

  for (const key of ['options', 'option', 'variants', 'variant', 'choices', 'choice', 'skuList']) {
    extractOptionsFromValue(value[key], collected, depth + 1);
  }

  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'string' || typeof nested === 'number') {
      if (/(?:option|variant|choice|color|colour|size)/i.test(key)) {
        const text = cleanText(String(nested));
        if (text && !OPTION_SKIP_RE.test(text)) collected.add(text);
      }
      continue;
    }

    extractOptionsFromValue(nested, collected, depth + 1);
  }

  return [...collected];
}

function extractScriptJsonValues(html: string): unknown[] {
  const $ = cheerio.load(html);
  const values: unknown[] = [];

  $('script').each((_, element) => {
    const text = $(element).text().trim();
    if (!text) return;

    if (!(text.startsWith('{') || text.startsWith('['))) return;
    try {
      values.push(JSON.parse(text));
    } catch {
      // Ignore non-JSON scripts.
    }
  });

  return values;
}

function extractJsonLdProducts(html: string, baseUrl: string): RawProduct[] {
  const $ = cheerio.load(html);
  const products: RawProduct[] = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    const text = $(element).text().trim();
    if (!text) return;

    try {
      const parsed = JSON.parse(text);
      gatherProducts(parsed, baseUrl, products);
    } catch {
      // Ignore invalid JSON-LD blocks.
    }
  });

  return products;
}

function parseProductRecord(
  item: Record<string, unknown>,
  baseUrl: string,
): RawProduct | null {
  const name = firstString(item, PRODUCT_NAME_KEYS);
  const salesPrice = firstPositive(
    ...PRODUCT_PRICE_KEYS.map((key) => item[key]),
    ...PRODUCT_CONSUMER_PRICE_KEYS.map((key) => item[key]),
  );
  const consumerPrice = firstPositive(
    ...PRODUCT_CONSUMER_PRICE_KEYS.map((key) => item[key]),
  );
  const imageUrl = extractImageUrl(
    PRODUCT_IMAGE_KEYS.map((key) => item[key]).find((candidate) => candidate !== undefined),
    baseUrl,
  );
  const url = extractUrl(
    PRODUCT_URL_KEYS.map((key) => item[key]).find((candidate) => candidate !== undefined),
    baseUrl,
  );
  const description = firstString(item, PRODUCT_DESCRIPTION_KEYS);
  const category = firstString(item, PRODUCT_CATEGORY_KEYS);
  const options = extractOptionsFromValue(
    item.options ?? item.option ?? item.variants ?? item.variant ?? item.choices ?? item.skuList,
  );

  if (!name || salesPrice <= 0 || (!imageUrl && !url)) {
    return null;
  }

  return {
    name,
    image_url: imageUrl,
    consumer_price: consumerPrice > 0 ? consumerPrice : salesPrice,
    sales_price: salesPrice,
    ...(description ? { description } : {}),
    ...(category ? { category } : {}),
    ...(url ? { url } : {}),
    ...(options.length > 0 ? { options } : {}),
  };
}

function gatherProducts(
  value: unknown,
  baseUrl: string,
  products: RawProduct[],
  depth = 0,
): void {
  if (!value || depth > 6) return;

  if (Array.isArray(value)) {
    const parsed = value
      .map((item) => (isRecord(item) ? parseProductRecord(item, baseUrl) : null))
      .filter((item): item is RawProduct => item !== null);

    if (parsed.length > 0) {
      products.push(...parsed);
      return;
    }

    for (const item of value) {
      gatherProducts(item, baseUrl, products, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) return;

  const parsed = parseProductRecord(value, baseUrl);
  if (parsed) {
    products.push(parsed);
    return;
  }

  for (const nested of Object.values(value)) {
    gatherProducts(nested, baseUrl, products, depth + 1);
  }
}

function extractProductsFromStructuredData(
  value: unknown,
  baseUrl: string,
): RawProduct[] {
  const products: RawProduct[] = [];
  gatherProducts(value, baseUrl, products);
  return products;
}

function extractCardProducts(html: string, baseUrl: string): RawProduct[] {
  const $ = cheerio.load(html);
  const products: RawProduct[] = [];

  for (const selector of CARD_SELECTORS) {
    $(selector).each((_, element) => {
      const product = $(element);
      const name =
        cleanText(
          product.attr('data-name') ||
            product.attr('data-product-name') ||
            product.attr('aria-label') ||
            '',
        ) ||
        firstText(product, [
          '[itemprop="name"]',
          '[class*=name]',
          '[class*=title]',
          'a[title]',
          'img[alt]',
          'h1',
          'h2',
          'h3',
          'h4',
          'p',
        ]) ||
        cleanText(product.text());

      const salesPrice = firstPositive(
        product.attr('data-price'),
        product.attr('data-sale-price'),
        product.attr('data-sales-price'),
        firstAttr(product, '[itemprop="price"]', ['content', 'data-price']),
        firstText(product, ['[class*=sale]', '[class*=price]', '[itemprop="price"]', '[data-price]']),
        findPriceText(product.text()),
      );
      const consumerPrice = firstPositive(
        product.attr('data-consumer-price'),
        product.attr('data-original-price'),
        product.attr('data-regular-price'),
        firstText(product, ['[class*=origin]', '[class*=regular]', '[class*=consumer]']),
        salesPrice,
      );
      const imageUrl = absoluteUrl(
        firstAttr(product, 'img', ['data-src', 'data-lazy-src', 'src']) ||
          firstAttr(product, 'source', ['srcset', 'src']) ||
          '',
        baseUrl,
      );
      const url = absoluteUrl(firstAttr(product, 'a[href]', ['href']) || '', baseUrl);

      if (!name || salesPrice <= 0 || (!imageUrl && !url)) return;

      products.push({
        name,
        image_url: imageUrl,
        consumer_price: consumerPrice > 0 ? consumerPrice : salesPrice,
        sales_price: salesPrice,
        ...(url ? { url } : {}),
      });
    });
  }

  return products;
}

function extractProductsFromHtml(html: string, baseUrl: string): RawProduct[] {
  const products = [
    ...extractJsonLdProducts(html, baseUrl),
    ...extractCardProducts(html, baseUrl),
  ];

  for (const value of extractScriptJsonValues(html)) {
    products.push(...extractProductsFromStructuredData(value, baseUrl));
  }

  return products;
}

function extractOptionsFromHtml(html: string): string[] {
  const $ = cheerio.load(html);
  const options = new Set<string>();

  $('select option, [class*=option] li, [class*=option] button, [role="option"]').each(
    (_, element) => {
      const text = cleanText($(element).text());
      if (text && !OPTION_SKIP_RE.test(text)) {
        options.add(text);
      }
    },
  );

  for (const value of extractScriptJsonValues(html)) {
    for (const option of extractOptionsFromValue(value)) {
      options.add(option);
    }
  }

  return [...options];
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
    options: product.options?.map((option) => cleanText(option)).filter(Boolean),
  };
}

function normalizeProducts(products: RawProduct[], baseUrl: string): RawProduct[] {
  const seen = new Set<string>();
  const normalized: RawProduct[] = [];

  for (const product of products) {
    const next = normalizeProduct(product, baseUrl);
    if (!next.name || !next.sales_price) continue;

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

function reportProgress(
  products: RawProduct[],
  onProgress?: (productName: string) => void,
): void {
  if (!onProgress) return;
  for (const product of products) {
    onProgress(product.name);
  }
}

async function fetchCandidateProducts(
  url: string,
  origin: string,
): Promise<RawProduct[]> {
  try {
    const response = await axios.get<unknown>(url, {
      headers: requestHeaders(origin),
      timeout: 15000,
      validateStatus: (status) => status >= 200 && status < 500,
    });

    if (response.status !== 200) return [];

    const data = response.data;
    if (Array.isArray(data) || isRecord(data)) {
      return extractProductsFromStructuredData(data, url);
    }

    if (typeof data !== 'string') return [];
    const trimmed = data.trim();
    if (!trimmed) return [];

    try {
      return extractProductsFromStructuredData(JSON.parse(trimmed), url);
    } catch {
      return [];
    }
  } catch {
    return [];
  }
}

async function fetchBundleUrls(bundleUrls: string[], origin: string): Promise<string[]> {
  const discovered = new Set<string>();
  const originHost = new URL(origin).hostname;

  for (const bundleUrl of bundleUrls.slice(0, MAX_BUNDLE_SOURCES)) {
    try {
      const response = await axios.get<string>(bundleUrl, {
        headers: requestHeaders(origin),
        timeout: 15000,
        validateStatus: (status) => status >= 200 && status < 500,
      });

      if (response.status !== 200) continue;

      for (const candidate of collectUrlsFromText(response.data, bundleUrl, originHost)) {
        discovered.add(candidate);
      }
    } catch {
      // Ignore bundle fetch failures.
    }
  }

  return [...discovered];
}

async function renderNuxtPage(url: string): Promise<{
  html: string;
  state: unknown;
  responseProducts: RawProduct[];
}> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    extraHTTPHeaders: {
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  const page = await context.newPage();
  const capturedResponses: Array<{ url: string; body: string }> = [];
  const originHost = new URL(url).hostname;

  page.on('response', async (response) => {
    try {
      if (capturedResponses.length >= MAX_CAPTURED_RESPONSES) return;

      const responseUrl = response.url();
      const parsed = safeUrl(responseUrl);
      if (!parsed || !isRelatedHost(parsed.hostname, originHost)) return;

      const contentType = response.headers()['content-type'] ?? '';
      const relevantPath =
        /(?:api|product|products|goods|search|searches|display|category|catalog|item|list|detail|graphql)/i.test(
          parsed.pathname,
        ) || parsed.pathname.endsWith('.json');

      if (!contentType.includes('json') && !relevantPath) return;

      const body = await response.text();
      if (!body.trim()) return;
      capturedResponses.push({ url: responseUrl, body });
    } catch {
      // Ignore noisy response parsing errors.
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(RENDER_WAIT_MS);

    const html = await page.content();
    const state = await page.evaluate(() => {
      const globalWindow = window as unknown as {
          __NUXT__?: unknown;
          __NUXT_DATA__?: unknown;
          __INITIAL_STATE__?: unknown;
          __PINIA__?: unknown;
        };

      return {
        nuxt: globalWindow.__NUXT__ ?? null,
        nuxtData: globalWindow.__NUXT_DATA__ ?? null,
        initialState: globalWindow.__INITIAL_STATE__ ?? null,
        pinia: globalWindow.__PINIA__ ?? null,
      };
    });

    const responseProducts: RawProduct[] = [];
    for (const { body, url: responseUrl } of capturedResponses) {
      try {
        const parsed = JSON.parse(body);
        responseProducts.push(
          ...extractProductsFromStructuredData(parsed, responseUrl),
        );
      } catch {
        // Ignore non-JSON responses.
      }
    }

    return { html, state, responseProducts };
  } finally {
    await context.close();
  }
}

async function enrichWithOptions(
  products: RawProduct[],
  originUrl: string,
): Promise<RawProduct[]> {
  const { default: pLimit } = await import('p-limit');
  const limit = pLimit(DETAIL_CONCURRENCY);

  return Promise.all(
    products.map((product) =>
      limit(async () => {
        if (!product.url) {
          return { ...product, options: product.options ?? [] };
        }

        try {
          const detailUrl = absoluteUrl(product.url, originUrl);
          const response = await axios.get<string>(detailUrl, {
            headers: requestHeaders(originUrl),
            timeout: 10000,
            validateStatus: (status) => status >= 200 && status < 500,
          });

          if (response.status !== 200) {
            return { ...product, options: product.options ?? [] };
          }

          const detailHtml = response.data;
          const options = new Set<string>(product.options ?? []);

          for (const option of extractOptionsFromHtml(detailHtml)) {
            options.add(option);
          }

          return {
            ...product,
            options: [...options],
          };
        } catch {
          return { ...product, options: product.options ?? [] };
        }
      }),
    ),
  );
}

async function crawlNuxt(
  url: string,
  onProgress?: (productName: string) => void,
): Promise<RawProduct[]> {
  console.log(`[nuxt] crawl start: ${url}`);

  let html = '';
  let finalUrl = url;

  try {
    const fetched = await fetchHtmlWithFallbackAndUrl(url);
    html = fetched.html;
    finalUrl = fetched.finalUrl || url;
    console.log(`[nuxt] page fetched (${html.length} chars)`);
  } catch (error) {
    console.warn('[nuxt] initial fetch failed:', error);
  }

  const origin = new URL(finalUrl).origin;
  const initialProducts = extractProductsFromHtml(html, finalUrl);
  const urls = collectUrlsFromHtml(html, finalUrl);
  const bundleSources = urls.filter(isNuxtBundleUrl);
  const apiSources = urls.filter(isLikelyDataEndpoint);

  console.log(
    `[nuxt] discovered ${bundleSources.length} bundle sources, ${apiSources.length} API sources`,
  );

  const bundleDerivedSources = await fetchBundleUrls(bundleSources, origin);
  const candidateSources = [...new Set([...apiSources, ...bundleDerivedSources])]
    .filter(isLikelyDataEndpoint)
    .slice(0, MAX_API_SOURCES);

  const apiProducts: RawProduct[] = [];
  for (const candidate of candidateSources) {
    const products = await fetchCandidateProducts(candidate, origin);
    if (products.length === 0) continue;
    console.log(`[nuxt] API candidate ${candidate}: ${products.length} products`);
    apiProducts.push(...products);
  }

  const firstPassProducts = normalizeProducts(
    [...initialProducts, ...apiProducts],
    finalUrl,
  );

  if (firstPassProducts.length >= MIN_PRODUCTS) {
    reportProgress(firstPassProducts, onProgress);
    return enrichWithOptions(firstPassProducts, finalUrl);
  }

  try {
    console.log('[nuxt] stage 2 -- Playwright render');
    const rendered = await renderNuxtPage(finalUrl);
    console.log(`[nuxt] rendered HTML (${rendered.html.length} chars)`);

    const renderedProducts = normalizeProducts(
      [
        ...firstPassProducts,
        ...extractProductsFromHtml(rendered.html, finalUrl),
        ...extractProductsFromStructuredData(rendered.state, finalUrl),
        ...rendered.responseProducts,
      ],
      finalUrl,
    );

    reportProgress(renderedProducts, onProgress);
    return enrichWithOptions(renderedProducts, finalUrl);
  } catch (error) {
    console.warn('[nuxt] render crawl failed:', error);
  }

  reportProgress(firstPassProducts, onProgress);
  return enrichWithOptions(firstPassProducts, finalUrl);
}

export const nuxtAdapter = {
  name: 'nuxt',

  detect(url: string, html = ''): boolean {
    return (
      url.includes('/_nuxt/') ||
      html.includes('/_nuxt/') ||
      html.includes('__NUXT__') ||
      html.includes('__NUXT_DATA__') ||
      html.includes('id="__nuxt"') ||
      html.includes("id='__nuxt'") ||
      html.includes('data-n-head')
    );
  },

  async crawl(
    url: string,
    onProgress?: (productName: string) => void,
  ): Promise<RawProduct[]> {
    return crawlNuxt(url, onProgress);
  },
} satisfies CrawlerAdapter;

export default nuxtAdapter;
