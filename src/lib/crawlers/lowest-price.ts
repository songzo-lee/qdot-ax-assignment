import * as cheerio from "cheerio";
import pLimit from "p-limit";
import type { RawProduct } from "../schemas/product";
import { getBrowser } from "./utils";

export interface PriceResult {
  price: number;
  platform: string;
  link: string;
  collected_at: string;
}

export interface ProductWithLowestPrice extends RawProduct {
  lowest_price_info?: PriceResult;
}

interface PriceCandidate extends PriceResult {
  resultName: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TOKEN_PATTERN = /[가-힣]+|[a-zA-Z]+|[0-9]+/g;

async function fetchNaverShopping(productName: string): Promise<string> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "ko-KR",
  });

  try {
    const page = await context.newPage();
    const url = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(productName)}&sort=price_asc`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(2_000);
    return await page.content();
  } finally {
    await context.close();
  }
}

async function fetchCoupang(productName: string): Promise<string> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "ko-KR",
  });

  try {
    const page = await context.newPage();
    const url = `https://www.coupang.com/np/search?q=${encodeURIComponent(productName)}&sorter=priceAsc`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(2_000);
    return await page.content();
  } finally {
    await context.close();
  }
}

function tokens(value: string): Set<string> {
  return new Set(
    (value.match(TOKEN_PATTERN) ?? []).map((token) => token.toLowerCase())
  );
}

export function tokenOverlap(a: string, b: string): number {
  const tokensA = tokens(a);
  const tokensB = tokens(b);
  let intersectionSize = 0;

  for (const token of tokensA) {
    if (tokensB.has(token)) {
      intersectionSize += 1;
    }
  }

  return intersectionSize / Math.max(tokensA.size, tokensB.size, 1);
}

function parsePrice(value: string): number | null {
  const price = Number(value.replace(/[^\d]/g, ""));
  return Number.isFinite(price) && price > 0 ? price : null;
}

function absoluteUrl(href: string | undefined, origin: string): string {
  if (!href) {
    return origin;
  }

  try {
    return new URL(href, origin).toString();
  } catch {
    return origin;
  }
}

function extractCandidates(
  html: string,
  platform: string,
  origin: string,
  itemSelector: string,
  priceSelector: string,
  nameSelectors: string[]
): PriceCandidate[] {
  const $ = cheerio.load(html);
  const candidates: PriceCandidate[] = [];

  $(itemSelector).each((_, element) => {
    const item = $(element);
    const resultName = nameSelectors
      .map((selector) => item.find(selector).first().text().trim())
      .find(Boolean);
    const priceText = item.find(priceSelector).first().text();
    const price = parsePrice(priceText);

    if (!resultName || price === null) {
      return;
    }

    candidates.push({
      price,
      platform,
      link: absoluteUrl(item.find("a[href]").first().attr("href"), origin),
      collected_at: new Date().toISOString(),
      resultName,
    });
  });

  return candidates;
}

export async function findLowestPrice(
  productName: string,
  brandName?: string,
  salesPrice?: number
): Promise<PriceResult | null> {
  const candidates: PriceCandidate[] = [];
  const searchQuery = brandName ? `${brandName} ${productName}` : productName;

  try {
    const origin = "https://search.shopping.naver.com";
    const html = await fetchNaverShopping(searchQuery);

    candidates.push(
      ...extractCandidates(
        html,
        "Naver Shopping",
        origin,
        "[class*='basicList_item'], [class*='product_item']",
        "[class*='price_num'], [class*='price'] em, [class*='price']",
        [
          "[class*='basicList_title']",
          "[class*='product_title']",
          "[class*='product_name']",
          "a[title]",
        ]
      )
    );
  } catch (error) {
    console.warn("[lowest-price] Naver Shopping lookup failed:", error);
  }

  try {
    const origin = "https://www.coupang.com";
    const html = await fetchCoupang(searchQuery);

    candidates.push(
      ...extractCandidates(
        html,
        "Coupang",
        origin,
        "[class*='search-product']",
        "[class*='price-value']",
        [".name", "[class*='name']", "a[title]"]
      )
    );
  } catch (error) {
    console.warn("[lowest-price] Coupang lookup failed:", error);
  }

  const validCandidates = candidates.filter(
    (candidate) =>
      tokenOverlap(candidate.resultName, searchQuery) >= 0.3 &&
      (salesPrice === undefined || candidate.price >= salesPrice * 0.1)
  );

  if (validCandidates.length === 0) {
    return null;
  }

  const { resultName: _resultName, ...lowestPrice } = validCandidates.reduce(
    (lowest, candidate) => (candidate.price < lowest.price ? candidate : lowest)
  );
  return lowestPrice;
}

function timeout(ms: number): Promise<null> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), ms);
  });
}

export async function enrichWithLowestPrices(
  products: RawProduct[],
  concurrency = 3
): Promise<ProductWithLowestPrice[]> {
  const limit = pLimit(concurrency);

  return Promise.all(
    products.map((product) =>
      limit(async () => {
        try {
          const brandName = (product as RawProduct & { brand?: string }).brand;
          const lowestPrice = await Promise.race([
            findLowestPrice(product.name, brandName, product.sales_price),
            timeout(10_000),
          ]);

          return {
            ...product,
            lowest_price_info: lowestPrice ?? undefined,
          };
        } catch {
          return {
            ...product,
            lowest_price_info: undefined,
          };
        }
      })
    )
  );
}
