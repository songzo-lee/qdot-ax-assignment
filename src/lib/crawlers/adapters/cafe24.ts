import axios from 'axios';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { RawProduct } from '../../schemas/product';
import type { CrawlerAdapter } from './types';

const MAX_PAGES = 100;
const DETAIL_CONCURRENCY = 10;
const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

type ListedProduct = RawProduct & {
  productNo: string;
};

type ParsedPage = {
  products: ListedProduct[];
  fingerprint: string;
};

function isCafe24Challenge(html: string): boolean {
  return (
    html.includes('veritas-hub.cafe24.com/challenge') ||
    html.includes('/.well-known/cc-challenge') ||
    (html.includes('challenges.cloudflare.com/turnstile') &&
      html.includes('img.cafe24.com')) ||
    (html.includes('Access Temporarily Restricted') &&
      html.includes('Cafe24 Corp.'))
  );
}

function assertNoCafe24Challenge(html: string): void {
  if (isCafe24Challenge(html)) {
    throw new Error(
      'Cafe24 접근 제한 챌린지로 크롤링이 차단되었습니다. 허용된 네트워크에서 다시 시도하거나 스토어의 접근 제한 설정을 확인해 주세요.',
    );
  }
}

function requestHeaders(origin: string): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Referer: `${origin}/`,
  };
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

function parsePrice(value: string): number {
  return parseInt(value.replace(/[^0-9]/g, ''), 10) || 0;
}

function extractProductNo(value: string, baseUrl: string): string {
  try {
    const url = new URL(value, baseUrl);
    const queryProductNo = url.searchParams.get('product_no')?.trim();
    if (queryProductNo) return queryProductNo;

    const seoMatch = url.pathname.match(
      /\/product\/(?:[^/]+\/)?(\d+)(?:\/category\/\d+)?(?:\/display\/\d+)?\/?$/i,
    );
    return seoMatch?.[1] ?? '';
  } catch {
    return '';
  }
}

function extractCategoryNo(value: string, baseUrl: string): string {
  try {
    const url = new URL(value, baseUrl);
    const queryCategoryNo = url.searchParams.get('cate_no')?.trim();
    if (queryCategoryNo) return queryCategoryNo;

    const seoMatch = url.pathname.match(/\/category\/[^/]+\/(\d+)\/?$/i);
    return seoMatch?.[1] ?? '';
  } catch {
    return '';
  }
}

function findProductLink(
  product: cheerio.Cheerio<AnyNode>,
  pageUrl: string,
): { url: string; productNo: string } | null {
  for (const element of product.find('a[href]').toArray()) {
    const href = product.find(element).attr('href')?.trim() ?? '';
    const productNo = extractProductNo(href, pageUrl);
    if (productNo) {
      return { url: absoluteUrl(href, pageUrl), productNo };
    }
  }

  const anchorId = product.attr('id') ?? '';
  const productNo = anchorId.match(/anchorBoxId_(\d+)/i)?.[1] ?? '';
  if (!productNo) return null;

  return {
    url: absoluteUrl(`/product/detail.html?product_no=${productNo}`, pageUrl),
    productNo,
  };
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

function findImageUrl(
  product: cheerio.Cheerio<AnyNode>,
  pageUrl: string,
): string {
  const image = product.find('img').first();
  for (const attribute of [
    'src',
    'data-src',
    'ec-data-src',
    'data-original',
    'data-lazy',
  ]) {
    const value = image.attr(attribute)?.trim();
    if (value) return absoluteUrl(value.split(/\s+/)[0], pageUrl);
  }
  return '';
}

function findProductName(product: cheerio.Cheerio<AnyNode>): string {
  const nameContainer = product.find('.name, .prdName, [class*=name]').first();
  if (nameContainer.length > 0) {
    const title = nameContainer
      .find('.title')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    const name = nameContainer.text().replace(title, '').replace(/\s+/g, ' ').trim();
    if (name) return name.replace(/^상품명\s*:\s*/, '');
  }

  return firstText(product, ['h2', 'h3', 'a[title]']).replace(
    /^상품명\s*:\s*/,
    '',
  );
}

function parsePrices(
  product: cheerio.Cheerio<AnyNode>,
): { consumerPrice: number; salesPrice: number } {
  const labeledPrices: Array<{ label: string; price: number }> = [];

  product.find('li, tr, .price, [class*=price]').each((_, element) => {
    const candidate = product.find(element);
    const text = candidate.text().replace(/\s+/g, ' ').trim();
    const price = parsePrice(text);
    if (!price) return;

    const label = candidate
      .find('.title, strong, th, dt')
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();
    labeledPrices.push({ label: label || text, price });
  });

  const consumerPrice =
    labeledPrices.find(({ label }) => /소비자가|정상가|판매가\s*전/.test(label))
      ?.price ?? 0;
  const discountedPrice =
    labeledPrices.find(({ label }) => /할인판매가|최적할인가|쿠폰적용가/.test(label))
      ?.price ?? 0;
  const regularSalesPrice =
    labeledPrices.find(({ label }) => /^판매가| 판매가/.test(label))?.price ?? 0;
  const allPrices = labeledPrices.map(({ price }) => price).filter(Boolean);
  const salesPrice =
    discountedPrice ||
    regularSalesPrice ||
    (allPrices.length > 0 ? Math.min(...allPrices) : 0);

  return {
    consumerPrice:
      consumerPrice ||
      (allPrices.length > 0 ? Math.max(...allPrices) : salesPrice),
    salesPrice,
  };
}

function productContainers($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> {
  const selectors = [
    '[id^="anchorBoxId_"]',
    '.prdList > li',
    '.xans-product-listnormal .xans-record-',
    '.xans-product-listmain .xans-record-',
    '[class*=xans-product-list] .xans-record-',
  ];

  for (const selector of selectors) {
    const elements = $(selector);
    if (elements.length > 0) return elements;
  }
  return $('');
}

function parseProductPage(html: string, pageUrl: string): ParsedPage {
  const $ = cheerio.load(html);
  const products: ListedProduct[] = [];

  productContainers($).each((_, element) => {
    const product = $(element);
    const link = findProductLink(product, pageUrl);
    if (!link) return;

    const name = findProductName(product);
    const { consumerPrice, salesPrice } = parsePrices(product);
    if (!name || !salesPrice) return;

    products.push({
      productNo: link.productNo,
      name,
      image_url: findImageUrl(product, pageUrl),
      consumer_price: Math.max(consumerPrice, salesPrice),
      sales_price: salesPrice,
      url: link.url,
    });
  });

  return {
    products,
    fingerprint: products
      .map(({ productNo, name, sales_price }) => `${productNo}\0${name}\0${sales_price}`)
      .join('\u0001'),
  };
}

function discoverCategoryUrls(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const categories = new Map<string, string>();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href')?.trim() ?? '';
    const categoryNo = extractCategoryNo(href, baseUrl);
    if (!categoryNo || categories.has(categoryNo)) return;

    const categoryUrl = new URL(absoluteUrl(href, baseUrl));
    if (
      !categoryUrl.pathname.includes('/product/list') &&
      !categoryUrl.pathname.includes('/category/')
    ) {
      return;
    }
    categoryUrl.searchParams.delete('page');
    categories.set(categoryNo, categoryUrl.href);
  });

  return [...categories.values()];
}

function pageUrl(categoryUrl: string, page: number): string {
  const url = new URL(categoryUrl);
  url.searchParams.set('page', String(page));
  return url.href;
}

async function crawlCategory(categoryUrl: string): Promise<ListedProduct[]> {
  const origin = new URL(categoryUrl).origin;
  const products: ListedProduct[] = [];
  let firstFingerprint = '';
  let previousFingerprint = '';

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    try {
      const currentUrl = pageUrl(categoryUrl, page);
      const response = await axios.get<string>(currentUrl, {
        headers: requestHeaders(origin),
        timeout: 15000,
      });
      assertNoCafe24Challenge(response.data);
      const parsed = parseProductPage(response.data, currentUrl);
      if (parsed.products.length === 0) break;
      if (
        parsed.fingerprint === previousFingerprint ||
        (page > 1 && parsed.fingerprint === firstFingerprint)
      ) {
        break;
      }

      products.push(...parsed.products);
      firstFingerprint ||= parsed.fingerprint;
      previousFingerprint = parsed.fingerprint;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Cafe24 접근 제한 챌린지')
      ) {
        throw error;
      }
      console.warn(`[cafe24] Category page ${page} failed for ${categoryUrl}:`, error);
      break;
    }
  }

  return products;
}

function optionLabel(
  $: cheerio.CheerioAPI,
  element: cheerio.Cheerio<AnyNode>,
): string {
  const optionTitle =
    element.attr('option_title') ||
    element.attr('data-option_title') ||
    element.attr('data-option-name');
  if (optionTitle?.trim()) return optionTitle.trim();

  const id = element.attr('id') ?? '';
  const explicitLabel = id ? $(`label[for="${id}"]`).first().text().trim() : '';
  if (explicitLabel) return explicitLabel;

  return element
    .closest('tr, li, div')
    .find('th, dt, label, .title')
    .first()
    .text()
    .replace(/\s+/g, ' ')
    .trim();
}

function parseOptions(html: string): string[] {
  const $ = cheerio.load(html);
  const options: string[] = [];

  $('select').each((_, element) => {
    const select = $(element);
    const name = select.attr('name') ?? '';
    const id = select.attr('id') ?? '';
    if (
      !/^option/i.test(name) &&
      !/product_option|option/i.test(id) &&
      !select.attr('option_title') &&
      !select.attr('data-option_title')
    ) {
      return;
    }

    const values = select
      .find('option')
      .map((_, option) => $(option).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(
        (value) =>
          value.length > 0 &&
          !/^(?:-+|\*+|선택|필수|옵션을 선택|choose|select|required)/i.test(
            value,
          ),
      );
    if (values.length === 0) return;

    const label = optionLabel($, select) || `옵션${options.length + 1}`;
    options.push(`${label}: ${[...new Set(values)].join(', ')}`);
  });

  return options;
}

async function enrichWithOptions(
  products: ListedProduct[],
  origin: string,
): Promise<RawProduct[]> {
  const { default: pLimit } = await import('p-limit');
  const limit = pLimit(DETAIL_CONCURRENCY);

  return Promise.all(
    products.map((listedProduct) =>
      limit(async () => {
        const { productNo, ...product } = listedProduct;

        try {
          const detailUrl =
            product.url ||
            absoluteUrl(`/product/detail.html?product_no=${productNo}`, origin);
          const response = await axios.get<string>(detailUrl, {
            headers: requestHeaders(origin),
            timeout: 15000,
          });
          return { ...product, options: parseOptions(response.data) };
        } catch (error) {
          console.warn(`[cafe24] Detail request failed for ${productNo}:`, error);
          return { ...product, options: [] };
        }
      }),
    ),
  );
}

function dedupeProducts(products: ListedProduct[]): ListedProduct[] {
  const unique = new Map<string, ListedProduct>();
  for (const product of products) {
    if (!unique.has(product.productNo)) unique.set(product.productNo, product);
  }
  return [...unique.values()];
}

export const cafe24Adapter = {
  name: 'cafe24',

  detect(url: string, html?: string): boolean {
    let host = '';
    let hasCafe24Path = false;

    try {
      const parsedUrl = new URL(url);
      host = parsedUrl.hostname;
      hasCafe24Path =
        parsedUrl.pathname.includes('/product/list.html') ||
        parsedUrl.pathname.includes('/product/detail.html');
    } catch {
      hasCafe24Path =
        url.includes('/product/list.html') || url.includes('/product/detail.html');
    }

    const source = html ?? '';
    const hasStrongSignal =
      /(?:^|\.)cafe24\.com$/i.test(host) ||
      /(?:^|\.)cafe24shop\.com$/i.test(host) ||
      source.includes('EC_FRONT_EXTERNAL_SCRIPT_VARIABLE_DATA') ||
      source.includes('/ind-script/optimizer.php');
    const signalCount = [
      hasStrongSignal,
      source.includes('xans-'),
      source.includes('xans-product-'),
      source.includes('EC-Product-list'),
      source.includes('img.echosting.cafe24.com'),
      source.includes('img.cafe24.com'),
      isCafe24Challenge(source),
      source.includes('CAFE24'),
    ].filter(Boolean).length;

    return (
      isCafe24Challenge(source) ||
      hasStrongSignal ||
      signalCount >= 2 ||
      (hasCafe24Path && signalCount >= 1)
    );
  },

  async crawl(
    url: string,
    onProgress?: (productName: string) => void,
  ): Promise<RawProduct[]> {
    const origin = new URL(url).origin;
    const response = await axios.get<string>(url, {
      headers: requestHeaders(origin),
      timeout: 15000,
    });
    const initialHtml = response.data;
    assertNoCafe24Challenge(initialHtml);
    const categoryUrls = discoverCategoryUrls(initialHtml, url);
    const listedProducts: ListedProduct[] = [];

    const initialProducts = parseProductPage(initialHtml, url).products;
    listedProducts.push(...initialProducts);

    if (categoryUrls.length > 0) {
      for (const categoryUrl of categoryUrls) {
        listedProducts.push(...(await crawlCategory(categoryUrl)));
      }
    } else if (initialProducts.length > 0) {
      listedProducts.push(...(await crawlCategory(url)));
    } else {
      const homepageResponse = await axios.get<string>(origin, {
        headers: requestHeaders(origin),
        timeout: 15000,
      });
      assertNoCafe24Challenge(homepageResponse.data);
      for (const categoryUrl of discoverCategoryUrls(homepageResponse.data, origin)) {
        listedProducts.push(...(await crawlCategory(categoryUrl)));
      }
    }

    const enrichedProducts = await enrichWithOptions(
      dedupeProducts(listedProducts),
      origin,
    );
    for (const product of enrichedProducts) onProgress?.(product.name);
    return enrichedProducts;
  },
} satisfies CrawlerAdapter;
