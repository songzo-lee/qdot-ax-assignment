import axios from 'axios';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { chromium } from 'playwright';
import type { RawProduct } from '../../schemas/product';
import { filterSoldOutProducts } from '../sold-out';
import type { CrawlerAdapter } from './types';

const MIN_PRODUCTS = 3;
const MAX_PAGES = 50;
const OPTION_CONCURRENCY = 5;
const OPTION_KEYWORDS_RE = /색상|사이즈|컬러|옵션|치수/;
const SKELETON_LIMIT = 4000;
const SMART_SKELETON_LIMIT = 800;
const PRICE_RE = /\d[\d,]*\s*원|₩\s*\d/;
const COMMON_PRODUCT_SELECTORS = [
  '[data-product-id]',
  '.product-item',
  '.product-card',
  '[class*=product][class*=item]',
] as const;

interface ProductSelectors {
  containerSelector?: string;
  nameSelector?: string;
  priceSelector?: string;
  imageSelector?: string;
}

interface PaginationPattern {
  buildUrl: (page: number) => string;
}

type GenericPageType = 'product_list' | 'product_detail' | 'placeholder' | 'unknown';

interface PageAnalysis {
  pageType: GenericPageType;
  confidence: number;
  shouldCrawl: boolean;
  reason?: string[];
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePrice(value: string): number {
  return parseInt(value.replace(/[^0-9]/g, ''), 10) || 0;
}

function isHostingPlaceholder(html: string): boolean {
  return [
    'NHN hosting',
    'hosting.godo.co.kr/common/img.mail/setting_top.gif',
    'hosting.godo.co.kr/common/img.mail/setting_bg.gif',
    'service is being applied',
    'hosting placeholder',
  ].some((marker) => html.includes(marker));
}

function assertNotHostingPlaceholder(html: string): void {
  if (isHostingPlaceholder(html)) {
    throw new Error(
      'This page looks like a hosting placeholder, not a real storefront.',
    );
  }
}

function absoluteUrl(value: string, pageUrl: string): string {
  if (!value) return '';

  try {
    return new URL(value, pageUrl).href;
  } catch {
    return '';
  }
}

function fingerprintProducts(products: RawProduct[]): string {
  return products.map((p) => `${p.name}\x00${p.sales_price}`).join('\x01');
}

function normalizeProduct(product: RawProduct, pageUrl: string): RawProduct {
  return {
    ...product,
    name: product.name.trim(),
    image_url: absoluteUrl(product.image_url, pageUrl),
    consumer_price: parsePrice(String(product.consumer_price)),
    sales_price: parsePrice(String(product.sales_price)),
    url: product.url ? absoluteUrl(product.url, pageUrl) : undefined,
  };
}

function normalizeProducts(
  products: RawProduct[],
  pageUrl: string,
): RawProduct[] {
  return filterSoldOutProducts(
    products
      .map((product) => normalizeProduct(product, pageUrl))
      .filter((product) => product.name.length > 0 && product.sales_price > 0),
  );
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function isNuxtLikeSite(url: string, html: string): boolean {
  return (
    url.includes('/_nuxt/') ||
    html.includes('/_nuxt/') ||
    html.includes('__NUXT__') ||
    html.includes('__NUXT_DATA__') ||
    html.includes('id="__nuxt"') ||
    html.includes("id='__nuxt'") ||
    html.includes('data-n-head')
  );
}

function shouldProbeShopify(url: string, html: string): boolean {
  if (isNuxtLikeSite(url, html)) return false;
  return (
    url.includes('myshopify.com') ||
    html.includes('myshopify.com') ||
    html.includes('cdn.shopify.com') ||
    html.includes('Shopify') ||
    html.includes('shopify')
  );
}

function shouldProbeWooCommerce(url: string, html: string): boolean {
  if (isNuxtLikeSite(url, html)) return false;
  return (
    url.includes('/wp-json/') ||
    html.includes('wp-json') ||
    html.includes('wp-content') ||
    html.includes('woocommerce') ||
    html.includes('WooCommerce') ||
    html.includes('wc/store')
  );
}

function parseShopifyProducts(data: unknown, pageUrl: string): RawProduct[] {
  if (!isRecord(data) || !Array.isArray(data.products)) return [];

  const products: RawProduct[] = [];
  for (const item of data.products) {
    if (!isRecord(item)) continue;

    const variants = Array.isArray(item.variants) ? item.variants : [];
    const firstVariant = variants.find(isRecord);
    const images = Array.isArray(item.images) ? item.images : [];
    const firstImage = images.find(isRecord);
    const salesPrice = parsePrice(stringValue(firstVariant?.price));
    const consumerPrice =
      parsePrice(stringValue(firstVariant?.compare_at_price)) || salesPrice;
    const handle = stringValue(item.handle);

    products.push({
      name: stringValue(item.title),
      image_url: stringValue(firstImage?.src),
      consumer_price: consumerPrice,
      sales_price: salesPrice,
      url: handle ? `/products/${handle}` : undefined,
    });
  }

  return normalizeProducts(products, pageUrl);
}

function parseWooCommerceProducts(data: unknown, pageUrl: string): RawProduct[] {
  if (!Array.isArray(data)) return [];

  const products: RawProduct[] = [];
  for (const item of data) {
    if (!isRecord(item)) continue;

    const images = Array.isArray(item.images) ? item.images : [];
    const firstImage = images.find(isRecord);
    const salesPrice =
      parsePrice(stringValue(item.sale_price)) ||
      parsePrice(stringValue(item.price)) ||
      parsePrice(stringValue(item.regular_price));
    const consumerPrice =
      parsePrice(stringValue(item.regular_price)) || salesPrice;

    products.push({
      name: stringValue(item.name),
      image_url: stringValue(firstImage?.src),
      consumer_price: consumerPrice,
      sales_price: salesPrice,
      description: stringValue(item.short_description),
      category: Array.isArray(item.categories)
        ? item.categories
            .filter(isRecord)
            .map((category) => stringValue(category.name))
            .filter(Boolean)
            .join(', ')
        : undefined,
      url: stringValue(item.permalink) || undefined,
    });
  }

  return normalizeProducts(products, pageUrl);
}

function firstText(
  product: cheerio.Cheerio<AnyNode>,
  selectors: readonly string[],
): string {
  for (const selector of selectors) {
    const text = product.find(selector).first().text().replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

function firstAttribute(
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

function parseHtmlProducts(
  html: string,
  pageUrl: string,
  selectors: ProductSelectors,
): RawProduct[] {
  if (!selectors.containerSelector) return [];

  const $ = cheerio.load(html);
  const products: RawProduct[] = [];

  $(selectors.containerSelector).each((_, element) => {
    const product = $(element);
    const name = selectors.nameSelector
      ? firstText(product, [selectors.nameSelector])
      : firstText(product, [
          '[data-product-title]',
          '.product-title',
          '.product-name',
          '[class*=title]',
          '[class*=name]',
          'h2',
          'h3',
        ]);
    const priceText = selectors.priceSelector
      ? firstText(product, [selectors.priceSelector])
      : firstText(product, [
          '[data-product-price]',
          '.price',
          '[class*=price]',
        ]);
    const imageSelector = selectors.imageSelector || 'img';
    const imageUrl = firstAttribute(product, imageSelector, [
      'src',
      'data-src',
      'data-lazy-src',
      'srcset',
    ]).split(/\s+/)[0];
    const productUrl = firstAttribute(product, 'a[href]', ['href']);
    const price = parsePrice(priceText);

    products.push({
      name,
      image_url: imageUrl,
      consumer_price: price,
      sales_price: price,
      url: productUrl || undefined,
    });
  });

  return normalizeProducts(products, pageUrl);
}

function parseSelectorResponse(value: string): ProductSelectors {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};

    return {
      containerSelector:
        typeof parsed.containerSelector === 'string'
          ? parsed.containerSelector
          : undefined,
      nameSelector:
        typeof parsed.nameSelector === 'string' ? parsed.nameSelector : undefined,
      priceSelector:
        typeof parsed.priceSelector === 'string'
          ? parsed.priceSelector
          : undefined,
      imageSelector:
        typeof parsed.imageSelector === 'string'
          ? parsed.imageSelector
          : undefined,
    };
  } catch {
    return {};
  }
}

function parsePageAnalysisResponse(value: string): PageAnalysis {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return { pageType: 'unknown', confidence: 0, shouldCrawl: true };
    }

    const rawPageType = String(parsed.pageType ?? '').trim();
    const pageType: GenericPageType =
      rawPageType === 'product_list' ||
      rawPageType === 'product_detail' ||
      rawPageType === 'placeholder' ||
      rawPageType === 'unknown'
        ? rawPageType
        : 'unknown';

    const confidenceValue = Number(parsed.confidence);
    const confidence = Number.isFinite(confidenceValue)
      ? Math.max(0, Math.min(1, confidenceValue))
      : 0;

    const reason = Array.isArray(parsed.reason)
      ? parsed.reason.filter((item): item is string => typeof item === 'string')
      : typeof parsed.reason === 'string'
        ? [parsed.reason]
        : undefined;

    return {
      pageType,
      confidence,
      shouldCrawl:
        typeof parsed.shouldCrawl === 'boolean'
          ? parsed.shouldCrawl
          : pageType !== 'placeholder',
      reason,
    };
  } catch {
    return { pageType: 'unknown', confidence: 0, shouldCrawl: true };
  }
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

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

interface Candidate {
  key: string;
  elements: cheerio.Cheerio<AnyNode>[];
  score: number;
}

function buildSmartSkeleton(html: string): string {
  const $ = cheerio.load(html);

  const groups = new Map<string, cheerio.Cheerio<AnyNode>[]>();

  $('*').each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    if (
      !tag ||
      ['html', 'head', 'body', 'script', 'style', 'meta', 'link', 'noscript'].includes(tag)
    )
      return;

    const rawClass =
      (el as { attribs?: Record<string, string> }).attribs?.class ?? '';
    const classes = [...new Set(rawClass.trim().split(/\s+/).filter(Boolean))]
      .sort()
      .join('.');
    if (!classes) return;
    const key = `${tag}.${classes}`;

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push($(el));
  });

  const candidates: Candidate[] = [];

  for (const [key, elements] of groups) {
    if (elements.length < MIN_PRODUCTS) continue;

    let score = 0;
    for (const el of elements) {
      if (PRICE_RE.test(el.text())) score += 2;
      if (el.find('img').length > 0) score += 1;
    }
    candidates.push({ key, elements, score });
  }

  if (candidates.length === 0) {
    $('script, style, link, meta, noscript, svg, iframe').remove();
    $('*').each((_, element) => {
      const el = $(element);
      const attribs =
        (element as { attribs?: Record<string, string> }).attribs ?? {};
      for (const attr of Object.keys(attribs)) {
        if (attr !== 'class' && attr !== 'id') el.removeAttr(attr);
      }
    });
    const skeleton = ($('body').html() ?? '').slice(0, SKELETON_LIMIT);
    console.log(`[generic] smart skeleton: no candidates, fallback ${skeleton.length} chars`);
    return skeleton;
  }

  candidates.sort(
    (a, b) => b.score - a.score || b.elements.length - a.elements.length,
  );

  const best = candidates[0];

  const samples = best.elements
    .slice(0, 3)
    .map((el) => $.html(el.get(0) as AnyNode) ?? '');

  let result = samples.join('\n');

  if (result.length > SMART_SKELETON_LIMIT) {
    result = ($.html(best.elements[0].get(0) as AnyNode) ?? '').slice(
      0,
      SMART_SKELETON_LIMIT,
    );
  }

  if (!result.trim()) {
    console.log(`[generic] smart skeleton: empty result, fallback`);
    return '';
  }

  console.log(
    `[generic] smart skeleton: key="${best.key}" score=${best.score} count=${best.elements.length} length=${result.length} chars`,
  );
  return result;
}

async function detectSelectors(html: string): Promise<ProductSelectors> {
  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const skeleton = buildSmartSkeleton(html);
    if (!skeleton) {
      console.warn('[generic] smart skeleton returned empty, skipping LLM call');
      return {};
    }
    console.log('[generic] calling LLM for selector detection...');
    const response = await client.chat.completions.create({
      model: 'gpt-5.4-nano',
      max_completion_tokens: 500,
      messages: [
        {
          role: 'user',
          content: `Analyze this e-commerce HTML skeleton (text removed, class/id preserved) and identify CSS selectors for repeated product cards. Return only valid JSON with this exact shape: {"containerSelector":"","nameSelector":"","priceSelector":"","imageSelector":""}. Selectors must be usable with Cheerio, and the name, price, and image selectors must be relative to the container selector.\n\nHTML skeleton:\n${skeleton}`,
        },
      ],
    });
    const responseText = response.choices[0].message.content ?? '';
    const selectors = parseSelectorResponse(responseText);
    console.log('[generic] LLM selectors:', JSON.stringify(selectors));
    return selectors;
  } catch (error) {
    console.warn('[generic] LLM selector detection failed:', error);
    return {};
  }
}

async function classifyPage(html: string): Promise<PageAnalysis> {
  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const skeleton = buildSmartSkeleton(html);
    if (!skeleton) {
      return { pageType: 'unknown', confidence: 0, shouldCrawl: true };
    }

    const response = await client.chat.completions.create({
      model: 'gpt-5.4-nano',
      max_completion_tokens: 300,
      messages: [
        {
          role: 'user',
          content:
            'Classify this page as product_list, product_detail, placeholder, or unknown. Return only JSON with keys pageType, confidence, shouldCrawl, reason. Set shouldCrawl false only for placeholder.\n\nHTML skeleton:\n' +
            skeleton,
        },
      ],
    });

    return parsePageAnalysisResponse(response.choices[0].message.content ?? '');
  } catch (error) {
    console.warn('[generic] LLM page classification failed:', error);
    return { pageType: 'unknown', confidence: 0, shouldCrawl: true };
  }
}

function parseDetailProduct(html: string, pageUrl: string): RawProduct[] {
  const $ = cheerio.load(html);
  const name = cleanText(
    firstMetaContent($, [
      'meta[property="og:title"]',
      'meta[name="title"]',
      'meta[property="twitter:title"]',
    ]) ||
      $('h1').first().text() ||
      $('h2').first().text() ||
      $('[class*=name]').first().text() ||
      $('[class*=title]').first().text(),
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
    parsePrice(
      firstMetaContent($, [
        'meta[property="product:price:amount"]',
        'meta[property="og:price:amount"]',
        'meta[name="product_price"]',
        'meta[itemprop="price"]',
      ]),
    ) ||
    parsePrice(
      cleanText(
        $('[class*=price]').first().text() ||
          $('.price').first().text() ||
          $('strong').first().text(),
      ),
    );

  if (!name || !salesPrice) return [];

  const consumerPrice =
    parsePrice(
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
          firstMetaContent($, ['meta[name="description"]']) ||
            $('[class*=desc]').first().text(),
        ),
        url: pageUrl,
      },
    ],
    pageUrl,
  );
}

async function crawlAnalyzedHtml(
  html: string,
  pageUrl: string,
  onProgress?: (productName: string) => void,
  label = 'HTML',
): Promise<RawProduct[] | null> {
  const analysis = await classifyPage(html);
  console.log(
    `[generic] ${label} pageType=${analysis.pageType} confidence=${analysis.confidence}`,
    analysis.reason?.join(', ') ?? '',
  );

  if (!analysis.shouldCrawl || analysis.pageType === 'placeholder') {
    throw new Error('cannot crawl placeholder page');
  }

  if (analysis.pageType === 'product_detail') {
    const products = parseDetailProduct(html, pageUrl);
    if (products.length > 0) {
      reportProgress(products, onProgress);
      return enrichWithOptions(products, pageUrl);
    }
    return null;
  }

  const selectors = await detectSelectors(html);
  const products = parseHtmlProducts(html, pageUrl, selectors);
  if (products.length >= MIN_PRODUCTS) {
    const all = await crawlAllPages(pageUrl, selectors, html, onProgress);
    return enrichWithOptions(all, pageUrl);
  }

  return null;
}

async function crawlWithClassification(
  url: string,
  initialHtml: string,
  onProgress?: (productName: string) => void,
): Promise<RawProduct[]> {
  try {
    const analyzedProducts = await crawlAnalyzedHtml(
      initialHtml,
      url,
      onProgress,
      'Stage 2',
    );
    if (analyzedProducts) {
      return analyzedProducts;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('cannot crawl placeholder page')) {
      throw error;
    }
    console.warn('[generic] LLM-assisted crawl failed:', error);
  }

  console.log('[generic] stage 3 -- Playwright render');
  try {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const renderedHtml = await page.content();
      console.log(`[generic] rendered HTML: ${renderedHtml.length} chars`);
      assertNotHostingPlaceholder(renderedHtml);
      const analyzedProducts = await crawlAnalyzedHtml(
        renderedHtml,
        url,
        onProgress,
        'Stage 3',
      );
      if (analyzedProducts) {
        return analyzedProducts;
      }
    } finally {
      await browser.close();
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('cannot crawl placeholder page')) {
      throw error;
    }
    console.warn('[generic] Playwright crawl failed:', error);
  }

  return [];
}

function reportProgress(
  products: RawProduct[],
  onProgress?: (productName: string) => void,
): RawProduct[] {
  for (const product of products) onProgress?.(product.name);
  return products;
}

async function detectPaginationUrl(
  url: string,
  selectors: ProductSelectors,
  firstFingerprint: string,
): Promise<PaginationPattern | null> {
  const builders: Array<(page: number) => string> = [
    (page) => {
      const u = new URL(url);
      u.searchParams.set('page', String(page));
      return u.href;
    },
    (page) => {
      const u = new URL(url);
      u.searchParams.set('p', String(page));
      return u.href;
    },
    (page) => {
      const u = new URL(url);
      u.pathname = u.pathname.replace(/\/page\/\d+\/?$/, '').replace(/\/$/, '') + `/page/${page}`;
      return u.href;
    },
  ];

  for (const buildUrl of builders) {
    try {
      const response = await axios.get<string>(buildUrl(2), { timeout: 10000 });
      const products = parseHtmlProducts(response.data, buildUrl(2), selectors);
      if (products.length === 0) continue;
      const fingerprint = fingerprintProducts(products);
      if (fingerprint && fingerprint !== firstFingerprint) {
        console.log(`[generic] pagination pattern found: ${buildUrl(2)}`);
        return { buildUrl };
      }
    } catch {
      // try next pattern
    }
  }
  return null;
}

async function crawlAllPages(
  url: string,
  selectors: ProductSelectors,
  firstHtml: string,
  onProgress?: (productName: string) => void,
): Promise<RawProduct[]> {
  const firstProducts = parseHtmlProducts(firstHtml, url, selectors);
  const firstFingerprint = fingerprintProducts(firstProducts);

  const pattern = await detectPaginationUrl(url, selectors, firstFingerprint);
  if (!pattern) {
    reportProgress(firstProducts, onProgress);
    return firstProducts;
  }

  const allProducts = [...firstProducts];
  reportProgress(firstProducts, onProgress);
  let previousFingerprint = firstFingerprint;

  for (let page = 2; page <= MAX_PAGES; page++) {
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const response = await axios.get<string>(pattern.buildUrl(page), {
        timeout: 10000,
      });
      const products = parseHtmlProducts(response.data, pattern.buildUrl(page), selectors);
      if (products.length === 0) break;

      const fingerprint = fingerprintProducts(products);
      if (
        fingerprint === previousFingerprint ||
        fingerprint === firstFingerprint
      )
        break;

      allProducts.push(...products);
      reportProgress(products, onProgress);
      previousFingerprint = fingerprint;
    } catch {
      console.warn(`[generic] pagination stopped at page ${page}`);
      break;
    }
  }

  console.log(`[generic] crawlAllPages: ${allProducts.length} products total`);
  return allProducts;
}

function extractOptions(html: string): string[] {
  const $ = cheerio.load(html);
  const results: string[] = [];

  // select 요소 탐지
  $('select').each((_, el) => {
    const select = $(el);
    const id = (el as { attribs?: Record<string, string> }).attribs?.id ?? '';
    const labelText = (
      id
        ? $(`label[for="${id}"]`).text().trim()
        : select.closest('div, tr, li').find('label').first().text().trim()
    );
    const nameAttr =
      (el as { attribs?: Record<string, string> }).attribs?.name ?? '';

    if (
      !OPTION_KEYWORDS_RE.test(labelText) &&
      !OPTION_KEYWORDS_RE.test(nameAttr)
    )
      return;

    const values = select
      .find('option')
      .map((_, opt) => $(opt).text().trim())
      .get()
      .filter((v) => v.length > 0 && !/^[-–—]+$|선택/.test(v));

    if (values.length > 0) {
      results.push(`${labelText || nameAttr || '옵션'}: ${values.join(', ')}`);
    }
  });

  // radio 그룹 탐지
  const radioGroups = new Map<string, { label: string; values: string[] }>();

  $('input[type="radio"]').each((_, el) => {
    const input = $(el);
    const name =
      (el as { attribs?: Record<string, string> }).attribs?.name ?? '';
    if (!name) return;

    if (!radioGroups.has(name)) {
      const fieldsetLegend = input
        .closest('fieldset')
        .find('legend')
        .first()
        .text()
        .trim();
      const nearbyHeading = input
        .closest('div, tr, li')
        .find('label, th, dt')
        .first()
        .text()
        .trim();
      const groupLabel = fieldsetLegend || nearbyHeading || name;
      radioGroups.set(name, { label: groupLabel, values: [] });
    }

    const inputId =
      (el as { attribs?: Record<string, string> }).attribs?.id ?? '';
    const valueLabel =
      $(`label[for="${inputId}"]`).text().trim() ||
      input.closest('label').text().trim() ||
      input.next('label').text().trim();

    if (valueLabel) radioGroups.get(name)!.values.push(valueLabel);
  });

  for (const { label, values } of radioGroups.values()) {
    if (!OPTION_KEYWORDS_RE.test(label) || values.length === 0) continue;
    results.push(`${label}: ${values.join(', ')}`);
  }

  return results;
}

async function enrichWithOptions(
  products: RawProduct[],
  originUrl: string,
): Promise<RawProduct[]> {
  const { default: pLimit } = await import('p-limit');
  const limit = pLimit(OPTION_CONCURRENCY);

  return Promise.all(
    products.map((product) =>
      limit(async () => {
        if (!product.url) return { ...product, options: [] };

        try {
          const detailUrl = absoluteUrl(product.url, originUrl);
          const response = await axios.get<string>(detailUrl, {
            timeout: 10000,
          });
          const options = extractOptions(response.data);
          console.log(
            `[generic] options for "${product.name}": ${options.length} found`,
          );
          return { ...product, options };
        } catch {
          return { ...product, options: [] };
        }
      }),
    ),
  );
}

export const genericAdapter = {
  name: 'generic',

  detect(_url: string, _html?: string): boolean {
    return true;
  },

  async crawl(
    url: string,
    onProgress?: (productName: string) => void,
  ): Promise<RawProduct[]> {
    const origin = new URL(url).origin;
    let html = '';

    // Stage 1: common APIs and HTML product-card patterns.
    console.log(`[generic] stage 1 — fetching ${url}`);
    try {
      const pageResponse = await axios.get<string>(url);
      html = pageResponse.data;
      console.log(`[generic] page fetched (${html.length} chars)`);

      if (shouldProbeShopify(url, html)) {
        try {
          const shopifyResponse = await axios.get<unknown>(
            new URL('/products.json?limit=250', origin).href,
            {
              validateStatus: (status) => status >= 200 && status < 500,
            },
          );
          if (shopifyResponse.status !== 200) {
            console.log(
              `[generic] Shopify API unavailable (${shopifyResponse.status})`,
            );
            // Not all storefronts expose Shopify APIs.
          }
          const products = parseShopifyProducts(shopifyResponse.data, url);
          console.log(`[generic] Shopify: ${products.length} products`);
          if (products.length >= MIN_PRODUCTS) {
            reportProgress(products, onProgress);
            return enrichWithOptions(products, url);
          }
        } catch (error) {
          console.warn('[generic] Shopify API crawl failed:', error);
        }
      }

      if (shouldProbeWooCommerce(url, html)) {
        try {
          const wooCommerceResponse = await axios.get<unknown>(
            new URL('/wp-json/wc/v2/products?per_page=100', origin).href,
            {
              validateStatus: (status) => status >= 200 && status < 500,
            },
          );
          if (wooCommerceResponse.status !== 200) {
            console.log(
              `[generic] WooCommerce API unavailable (${wooCommerceResponse.status})`,
            );
            // Not all storefronts expose WooCommerce APIs.
          }
          const products = parseWooCommerceProducts(wooCommerceResponse.data, url);
          console.log(`[generic] WooCommerce: ${products.length} products`);
          if (products.length >= MIN_PRODUCTS) {
            reportProgress(products, onProgress);
            return enrichWithOptions(products, url);
          }
        } catch (error) {
          console.warn('[generic] WooCommerce API crawl failed:', error);
        }
      }

      for (const containerSelector of COMMON_PRODUCT_SELECTORS) {
        const products = parseHtmlProducts(html, url, { containerSelector });
        console.log(`[generic] selector "${containerSelector}": ${products.length} products`);
        if (products.length >= MIN_PRODUCTS) {
          const all = await crawlAllPages(
            url,
            { containerSelector },
            html,
            onProgress,
          );
          return enrichWithOptions(all, url);
        }
      }
    } catch (error) {
      console.warn('[generic] Common-pattern crawl failed:', error);
    }
    return html ? crawlWithClassification(url, html, onProgress) : [];
  },
} satisfies CrawlerAdapter;

export default genericAdapter;
