import axios from 'axios';
import * as cheerio from 'cheerio';
import type { Readable } from 'stream';
import type { RawProduct } from '../../schemas/product';
import type { CrawlerAdapter } from './types';

const PAGE_SIZE = 200;
const DETAIL_CONCURRENCY = 10;
const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const SPEC_KEYWORD_RE =
  /<th[^>]*>\s*(?:색상|사이즈|치수|컬러|옵션)\s*<\/th>/i;

type ListedProduct = RawProduct & {
  goodsNo: string;
};

type ParsedPage = {
  products: ListedProduct[];
  totalCount?: number;
  fingerprint: string;
};

type CookieJar = {
  value: string;
};

function requestHeaders(origin: string, cookieString = ''): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    Referer: `${origin}/`,
    ...(cookieString ? { Cookie: cookieString } : {}),
  };
}

function captureCookies(
  headers: Record<string, unknown>,
  cookieJar: CookieJar,
): void {
  const setCookie = headers['set-cookie'];
  if (Array.isArray(setCookie)) {
    cookieJar.value = setCookie
      .filter((cookie): cookie is string => typeof cookie === 'string')
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
  } else if (typeof setCookie === 'string') {
    cookieJar.value = setCookie.split(';')[0];
  }
}

function parseSalesPrice(value: string): number {
  return Math.round(parseFloat(value.replace(/[^0-9.]/g, '')) || 0);
}

function parseConsumerPrice(value: string): number {
  return parseSalesPrice(value);
}

function resolveImageUrl(imageUrl: string, origin: string): string {
  if (!imageUrl) return '';
  if (imageUrl.startsWith('//')) return `https:${imageUrl}`;
  return new URL(imageUrl, `${origin}/`).href;
}

function parseTotalCount(
  $: cheerio.CheerioAPI,
  productCount: number,
): number | undefined {
  const candidateTexts = new Set<string>();

  $('.total_count, [class*=total]').each((_, element) => {
    const candidate = $(element);
    candidateTexts.add(candidate.text().trim());
    candidateTexts.add(candidate.parent().text().trim());
  });

  $('body *').each((_, element) => {
    const text = $(element).clone().children().remove().end().text().trim();
    if (/(?:총|전체|상품\s*(?:수|개수|건수))/.test(text)) {
      candidateTexts.add(text);
    }
  });

  const patterns = [
    /(?:총|전체)\s*(?:상품)?\s*([\d,]+)\s*(?:개|건)/,
    /상품\s*(?:수|개수|건수)\s*[:：]?\s*([\d,]+)/,
    /([\d,]+)\s*(?:개|건)\s*(?:의\s*)?상품/,
  ];
  const counts: number[] = [];

  for (const text of candidateTexts) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const count = match ? parseInt(match[1].replace(/,/g, ''), 10) : 0;
      if (count >= productCount) counts.push(count);
    }
  }

  return counts.length > 0 ? Math.max(...counts) : undefined;
}

function parseProductPage(html: string, origin: string): ParsedPage {
  const $ = cheerio.load(html);
  const products: ListedProduct[] = [];

  $('[data-goods-nm]').each((_, element) => {
    const product = $(element);
    const goodsNo = product.attr('data-goods-no')?.trim() || '';
    const name = product.attr('data-goods-nm')?.trim() || '';
    let salesPrice = parseSalesPrice(product.attr('data-goods-price') || '0');
    const imageUrl = resolveImageUrl(
      product.attr('data-goods-image-src') || '',
      origin,
    );
    const productContainer = product.closest('li, .goods_prd_item2_box');
    const consumerPriceSelectors = [
      '.goods_price .org',
      '.org_price',
      '.goods_price [class*=consumer]',
      '[class*=consumer]',
      '.goods_price del',
      '.goods_price s',
      'del',
      's',
    ];
    let consumerPrice = 0;

    for (const selector of consumerPriceSelectors) {
      consumerPrice = parseConsumerPrice(
        productContainer.find(selector).first().text().trim(),
      );
      if (consumerPrice) break;
    }
    consumerPrice ||= salesPrice;

    if (consumerPrice < salesPrice) {
      [consumerPrice, salesPrice] = [salesPrice, consumerPrice];
    }

    if (!goodsNo || !name || !salesPrice) return;

    products.push({
      name,
      image_url: imageUrl,
      consumer_price: consumerPrice,
      sales_price: salesPrice,
      goodsNo,
      url: `${origin}/goods/goods_view.php?goodsNo=${encodeURIComponent(goodsNo)}`,
    });
  });

  return {
    products,
    totalCount: parseTotalCount($, products.length),
    fingerprint: products
      .map(
        ({ goodsNo, name, image_url, sales_price }) =>
          `${goodsNo}\u0000${name}\u0000${image_url}\u0000${sales_price}`,
      )
      .join('\u0001'),
  };
}

function parseOptions(html: string): string[] {
  const $ = cheerio.load(html);
  const results = new Set<string>();
  const keywords = ['색상', '사이즈', '치수', '컬러', '옵션'];

  $('table tr').each((_, row) => {
    const heading = $(row).find('th').first().text().replace(/\s+/g, ' ').trim();
    if (!keywords.some((keyword) => heading.includes(keyword))) return;

    const value = $(row).find('td').first().text().replace(/\s+/g, ' ').trim();
    if (value) results.add(`${heading}: ${value}`);
  });

  return [...results];
}

async function fetchPartialHtml(
  origin: string,
  goodsNo: string,
  cookieString: string,
): Promise<{ html: string; status: number }> {
  const response = await axios.get<Readable>(
    `${origin}/goods/goods_view.php`,
    {
      headers: requestHeaders(origin, cookieString),
      params: { goodsNo },
      responseType: 'stream',
      validateStatus: () => true,
    },
  );

  if (response.status !== 200) return { html: '', status: response.status };

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let keywordPosition = -1;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve({
        html: Buffer.concat(chunks).toString('utf-8'),
        status: response.status,
      });
    };

    response.data.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const current = Buffer.concat(chunks).toString('utf-8');

      if (keywordPosition < 0) {
        const match = SPEC_KEYWORD_RE.exec(current);
        if (match) keywordPosition = match.index;
      }

      if (
        keywordPosition >= 0 &&
        current.indexOf('</table>', keywordPosition) >= 0
      ) {
        response.data.destroy();
      }
    });
    response.data.on('end', finish);
    response.data.on('close', finish);
    response.data.on('error', (error: Error) => {
      if (chunks.length > 0) finish();
      else reject(error);
    });
  });
}

async function fetchProductOptions(
  origin: string,
  goodsNo: string,
  cookieString: string,
): Promise<string[]> {
  if (!goodsNo) return [];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { html, status } = await fetchPartialHtml(
      origin,
      goodsNo,
      cookieString,
    );
    if (status === 200) return parseOptions(html);
    if (attempt < 3) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, attempt * 1000);
      });
    }
  }

  return [];
}

async function enrichWithOptions(
  origin: string,
  products: ListedProduct[],
  cookieString: string,
): Promise<RawProduct[]> {
  const { default: pLimit } = await import('p-limit');
  const limit = pLimit(DETAIL_CONCURRENCY);

  return Promise.all(
    products.map((listedProduct) =>
      limit(async () => {
        const { goodsNo, ...product } = listedProduct;

        try {
          return {
            ...product,
            options: await fetchProductOptions(origin, goodsNo, cookieString),
          };
        } catch (error) {
          console.warn(
            `[godomall] Detail request failed for goodsNo ${goodsNo}:`,
            error,
          );
          return { ...product, options: [] };
        }
      }),
    ),
  );
}

async function collectHttpPages(
  origin: string,
  fetchPage: (page: number) => Promise<string>,
): Promise<ListedProduct[] | null> {
  const firstPage = parseProductPage(await fetchPage(1), origin);
  if (firstPage.products.length === 0) return null;

  const secondPage = parseProductPage(await fetchPage(2), origin);
  if (
    secondPage.products.length > 0 &&
    secondPage.fingerprint === firstPage.fingerprint
  ) {
    return null;
  }

  const products = [...firstPage.products];
  const pageCount = firstPage.totalCount
    ? Math.ceil(firstPage.totalCount / firstPage.products.length)
    : undefined;

  if (pageCount === 1 || secondPage.products.length === 0) return products;

  products.push(...secondPage.products);
  let previousFingerprint = secondPage.fingerprint;

  for (let page = 3; pageCount === undefined || page <= pageCount; page += 1) {
    const parsedPage = parseProductPage(await fetchPage(page), origin);
    if (parsedPage.products.length === 0) break;
    if (
      parsedPage.fingerprint === previousFingerprint ||
      parsedPage.fingerprint === firstPage.fingerprint
    ) {
      return null;
    }

    products.push(...parsedPage.products);
    previousFingerprint = parsedPage.fingerprint;
  }

  return products;
}

async function crawlHttpPages(
  origin: string,
  listUrl: string,
  cateCd: string | undefined,
  cookieJar: CookieJar,
): Promise<ListedProduct[]> {
  for (const sizeParameter of ['listCount', 'pageSize'] as const) {
    try {
      const products = await collectHttpPages(origin, async (page) => {
        const response = await axios.get<string>(listUrl, {
          headers: requestHeaders(origin, cookieJar.value),
          params: { page, [sizeParameter]: PAGE_SIZE },
        });
        captureCookies(response.headers, cookieJar);
        return response.data;
      });
      if (products) return products;
    } catch (error) {
      console.warn(
        `[godomall] GET pagination with ${sizeParameter} failed for ${listUrl}:`,
        error,
      );
    }
  }

  try {
    const products = await collectHttpPages(origin, async (page) => {
      const body = new URLSearchParams({
        page: String(page),
        listCount: String(PAGE_SIZE),
        ...(cateCd ? { cateCd } : {}),
      });
      const response = await axios.post<string>(
        `${origin}/goods/goods_list_ajax.php`,
        body,
        {
          headers: {
            ...requestHeaders(origin, cookieJar.value),
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
          },
        },
      );
      captureCookies(response.headers, cookieJar);
      return response.data;
    });
    return products ?? [];
  } catch (error) {
    console.warn(`[godomall] AJAX pagination failed for ${listUrl}:`, error);
    return [];
  }
}

async function discoverCategoryCodes(
  origin: string,
  cookieJar: CookieJar,
): Promise<string[]> {
  try {
    const response = await axios.get<string>(`${origin}/goods/goods_cate.php`, {
      headers: requestHeaders(origin, cookieJar.value),
    });
    captureCookies(response.headers, cookieJar);

    const $ = cheerio.load(response.data);
    const cateCds = new Set<string>();

    $('a[href]').each((_, element) => {
      const href = $(element).attr('href');
      if (!href) return;

      try {
        const link = new URL(href, `${origin}/goods/goods_cate.php`);
        if (!link.pathname.includes('/goods/goods_list.php')) return;
        const cateCd = link.searchParams.get('cateCd')?.trim();
        if (cateCd) cateCds.add(cateCd);
      } catch {
        // Ignore malformed links in store navigation.
      }
    });

    return [...cateCds];
  } catch (error) {
    console.warn('[godomall] Category discovery failed:', error);
    return [];
  }
}

function dedupeByGoodsNo(products: ListedProduct[]): ListedProduct[] {
  const uniqueProducts = new Map<string, ListedProduct>();
  for (const product of products) {
    if (!uniqueProducts.has(product.goodsNo)) {
      uniqueProducts.set(product.goodsNo, product);
    }
  }
  return [...uniqueProducts.values()];
}

export const godomallAdapter = {
  name: 'godomall',

  detect(url: string, html?: string): boolean {
    let hasListPath = false;
    try {
      hasListPath = new URL(url).pathname.includes('/goods/goods_list.php');
    } catch {
      hasListPath = url.includes('/goods/goods_list.php');
    }

    return (
      hasListPath ||
      html?.includes('data-goods-nm') === true ||
      html?.includes('/goods/goods_view.php') === true
    );
  },

  async crawl(
    url: string,
    onProgress?: (productName: string) => void,
  ): Promise<RawProduct[]> {
    const origin = new URL(url).origin;
    const cookieJar: CookieJar = { value: '' };
    const cateCds = await discoverCategoryCodes(origin, cookieJar);
    const listedProducts: ListedProduct[] = [];

    if (cateCds.length > 0) {
      for (const cateCd of cateCds) {
        const listUrl = new URL('/goods/goods_list.php', origin);
        listUrl.searchParams.set('cateCd', cateCd);
        listedProducts.push(
          ...(await crawlHttpPages(
            origin,
            listUrl.href,
            cateCd,
            cookieJar,
          )),
        );
      }
    } else {
      listedProducts.push(
        ...(await crawlHttpPages(
          origin,
          `${origin}/goods/goods_list.php`,
          undefined,
          cookieJar,
        )),
      );
    }

    const enrichedProducts = await enrichWithOptions(
      origin,
      dedupeByGoodsNo(listedProducts),
      cookieJar.value,
    );
    for (const product of enrichedProducts) {
      onProgress?.(product.name);
    }
    return enrichedProducts;
  },
} satisfies CrawlerAdapter;
