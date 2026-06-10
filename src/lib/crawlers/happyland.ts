import axios from "axios";
import * as cheerio from "cheerio";
import type { RawProduct } from "../schemas/product";

const BASE_URL = "https://m.happylandmall.com";
const STORE_URL = `${BASE_URL}/`;
const PRODUCT_LIST_URL = `${BASE_URL}/goods/goods_list.php?cateCd=014008`;
const PRODUCT_LIST_AJAX_URL = `${BASE_URL}/goods/goods_list_ajax.php`;
const PRODUCT_DETAIL_URL = `${BASE_URL}/goods/goods_view.php`;
const PAGE_SIZE = 200;
const DETAIL_CONCURRENCY = 10;
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const REQUEST_HEADERS = {
  "User-Agent": USER_AGENT,
  Referer: STORE_URL,
};

type ListedProduct = RawProduct & {
  goodsNo: string;
};

type ParsedPage = {
  products: ListedProduct[];
  totalCount?: number;
  fingerprint: string;
};

function parseSalesPrice(value: string): number {
  return Math.round(parseFloat(value.replace(/[^0-9.]/g, "")) || 0);
}

function parseConsumerPrice(value: string): number {
  return parseInt(value.replace(/[^0-9]/g, ""), 10) || 0;
}

function resolveImageUrl(imageUrl: string): string {
  if (!imageUrl) return "";
  if (imageUrl.startsWith("//")) return `https:${imageUrl}`;
  return new URL(imageUrl, STORE_URL).href;
}

function parseTotalCount(
  $: cheerio.CheerioAPI,
  productCount: number
): number | undefined {
  const candidateTexts = new Set<string>();

  $(".total_count, [class*=total]").each((_, element) => {
    const candidate = $(element);
    candidateTexts.add(candidate.text().trim());
    candidateTexts.add(candidate.parent().text().trim());
  });

  $("body *").each((_, element) => {
    const text = $(element).clone().children().remove().end().text().trim();
    if (
      /(?:\uCD1D|\uC804\uCCB4|\uC0C1\uD488\s*(?:\uC218|\uAC1C\uC218|\uAC74\uC218))/.test(
        text
      )
    ) {
      candidateTexts.add(text);
    }
  });

  const patterns = [
    /(?:\uCD1D|\uC804\uCCB4)\s*(?:\uC0C1\uD488)?\s*([\d,]+)\s*(?:\uAC1C|\uAC74)/,
    /\uC0C1\uD488\s*(?:\uC218|\uAC1C\uC218|\uAC74\uC218)\s*[:\uFF1A]?\s*([\d,]+)/,
    /([\d,]+)\s*(?:\uAC1C|\uAC74)\s*(?:\uC758\s*)?\uC0C1\uD488/,
  ];
  const counts: number[] = [];

  for (const text of candidateTexts) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const count = match ? parseInt(match[1].replace(/,/g, ""), 10) : 0;
      if (count >= productCount) counts.push(count);
    }
  }

  return counts.length > 0 ? Math.max(...counts) : undefined;
}

function parseProductPage(html: string): ParsedPage {
  const $ = cheerio.load(html);
  const products: ListedProduct[] = [];

  $("[data-goods-nm]").each((_, element) => {
    const product = $(element);
    const goodsNo = product.attr("data-goods-no") || "";
    const name = product.attr("data-goods-nm") || "";
    const salesPrice = parseSalesPrice(product.attr("data-goods-price") || "0");
    const imageUrl = resolveImageUrl(
      product.attr("data-goods-image-src") || ""
    );
    const productContainer = product.closest("li, .goods_prd_item2_box");
    const originalPriceText = productContainer
      .find(".org_price, [class*=consumer]")
      .first()
      .text()
      .trim();
    const consumerPrice = originalPriceText
      ? parseConsumerPrice(originalPriceText) || salesPrice
      : salesPrice;

    if (!name || !salesPrice) return;

    products.push({
      name,
      image_url: imageUrl,
      consumer_price: consumerPrice,
      sales_price: salesPrice,
      goodsNo,
    });
  });

  return {
    products,
    totalCount: parseTotalCount($, products.length),
    fingerprint: products
      .map(
        ({ name, image_url, sales_price }) =>
          `${name}\u0000${image_url}\u0000${sales_price}`
      )
      .join("\u0001"),
  };
}

function reportProducts<T extends RawProduct>(
  products: T[],
  onProgress?: (productName: string) => void
): T[] {
  for (const product of products) {
    onProgress?.(product.name);
  }
  return products;
}

function parseOptions(html: string): string[] {
  const $ = cheerio.load(html);
  const results: string[] = [];
  const keywords = ["색상", "사이즈", "치수", "컬러", "옵션"];

  $("table tr").each((_, row) => {
    const th = $(row).find("th").first().text().trim();
    if (!keywords.some((kw) => th.includes(kw))) return;
    const value = $(row).find("td").first().text().trim();
    if (value) results.push(`${th}: ${value}`);
  });

  return results;
}

// 스펙 테이블(색상/치수 th) 이후 첫 번째 </table>에서 스트림 중단
// 측정값: 테이블 종료 ~55KB, TCP 청크 경계상 실제 수신 ~65KB (95KB 대비 31% 절약)
const SPEC_KEYWORD_RE = /<th[^>]*>\s*(?:색상|치수|사이즈|컬러|옵션)\s*<\/th>/;

async function fetchPartialHtml(
  goodsNo: string,
  cookieString: string
): Promise<{ html: string; status: number }> {
  const res = await axios.get<import("stream").Readable>(PRODUCT_DETAIL_URL, {
    headers: { ...REQUEST_HEADERS, Cookie: cookieString },
    params: { goodsNo },
    responseType: "stream",
    validateStatus: () => true,
  });

  if (res.status !== 200) return { html: "", status: res.status };

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let keywordPos = -1;

    const finish = () =>
      resolve({ html: Buffer.concat(chunks).toString("utf-8"), status: res.status });

    res.data.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const current = Buffer.concat(chunks).toString("utf-8");

      if (keywordPos < 0) {
        const m = SPEC_KEYWORD_RE.exec(current);
        if (m) keywordPos = m.index;
      }

      if (keywordPos >= 0 && current.indexOf("</table>", keywordPos) >= 0) {
        res.data.destroy();
      }
    });

    res.data.on("close", finish);
    res.data.on("error", (err: Error) => {
      if (chunks.length > 0) finish(); else reject(err);
    });
  });
}

async function fetchProductOptions(
  goodsNo: string,
  cookieString: string
): Promise<string[]> {
  if (!goodsNo) return [];

  for (let attempt = 1; attempt <= 3; attempt++) {
    const { html, status } = await fetchPartialHtml(goodsNo, cookieString);
    if (status === 200) return parseOptions(html);
    if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
  }
  return [];
}

async function enrichWithOptions(
  products: ListedProduct[],
  cookieString: string
): Promise<RawProduct[]> {
  const { default: pLimit } = await import("p-limit");
  const limit = pLimit(DETAIL_CONCURRENCY);
  let processedCount = 0;

  return Promise.all(
    products.map((listedProduct) =>
      limit(async () => {
        const { goodsNo, ...product } = listedProduct;
        let enrichedProduct: RawProduct;

        try {
          enrichedProduct = {
            ...product,
            options: await fetchProductOptions(goodsNo, cookieString),
          };
        } catch (error) {
          console.warn(
            `[happyland] Detail request failed for goodsNo ${goodsNo}:`,
            error
          );
          enrichedProduct = { ...product, options: [] };
        }

        processedCount += 1;
        if (processedCount % 100 === 0) {
          console.log(`[happyland] Processed ${processedCount} products`);
        }

        return enrichedProduct;
      })
    )
  );
}

async function finalizeProducts(
  products: ListedProduct[],
  cookieString: string,
  onProgress?: (productName: string) => void
): Promise<RawProduct[]> {
  reportProducts(products, onProgress);
  return enrichWithOptions(products, cookieString);
}

async function crawlHttpPages(
  fetchPage: (page: number) => Promise<string>
): Promise<ListedProduct[] | null> {
  const firstPage = parseProductPage(await fetchPage(1));
  if (firstPage.products.length === 0) return null;

  const secondPage = parseProductPage(await fetchPage(2));
  if (
    secondPage.products.length > 0 &&
    secondPage.fingerprint === firstPage.fingerprint
  ) {
    return null;
  }

  const products: ListedProduct[] = [];
  products.push(...firstPage.products);

  const pageCount = firstPage.totalCount
    ? Math.ceil(firstPage.totalCount / firstPage.products.length)
    : undefined;
  if (pageCount === 1 || secondPage.products.length === 0) return products;

  products.push(...secondPage.products);
  let previousFingerprint = secondPage.fingerprint;

  for (let page = 3; pageCount === undefined || page <= pageCount; page += 1) {
    const parsedPage = parseProductPage(await fetchPage(page));
    if (parsedPage.products.length === 0) break;
    if (
      parsedPage.fingerprint === previousFingerprint ||
      parsedPage.fingerprint === firstPage.fingerprint
    )
      return null;

    products.push(...parsedPage.products);
    previousFingerprint = parsedPage.fingerprint;
  }

  return products;
}

async function crawlWithPlaywright(): Promise<ListedProduct[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ userAgent: USER_AGENT });
    await page.goto(PRODUCT_LIST_URL, { waitUntil: "domcontentloaded" });

    for (let attempts = 0; attempts < 500; attempts += 1) {
      const beforeCount = await page.locator("[data-goods-nm]").count();
      const moreButtons = page.locator(
        ".btn_more, [class*=more], button:has-text('\uB354\uBCF4\uAE30')"
      );
      let clicked = false;

      for (let index = 0; index < (await moreButtons.count()); index += 1) {
        const button = moreButtons.nth(index);
        const text = (await button.textContent())?.trim() || "";
        const isMoreButton =
          text.includes("\uB354\uBCF4\uAE30") ||
          (await button.getAttribute("class"))?.includes("btn_more");
        if (isMoreButton && (await button.isVisible())) {
          await button.click();
          clicked = true;
          break;
        }
      }

      if (!clicked) break;
      await page
        .waitForFunction(
          (count) =>
            document.querySelectorAll("[data-goods-nm]").length > count,
          beforeCount,
          { timeout: 5000 }
        )
        .catch(() => null);
      if ((await page.locator("[data-goods-nm]").count()) <= beforeCount) break;
    }

    const parsedPage = parseProductPage(await page.content());
    return parsedPage.products;
  } finally {
    await browser.close();
  }
}

export async function crawlHappyland(
  onProgress?: (productName: string) => void
): Promise<RawProduct[]> {
  try {
    let cookieString = "";

    // Approach 1: use axios GET URL-parameter pagination before runtime fallbacks.
    for (const sizeParameter of ["listCount", "pageSize"] as const) {
      try {
        const products = await crawlHttpPages(async (page) => {
          const response = await axios.get<string>(PRODUCT_LIST_URL, {
            headers: REQUEST_HEADERS,
            params: { page, [sizeParameter]: PAGE_SIZE },
          });
          if (page === 1) {
            const setCookieHeader = response.headers["set-cookie"];
            cookieString = Array.isArray(setCookieHeader)
              ? setCookieHeader.map((c) => c.split(";")[0]).join("; ")
              : (setCookieHeader ?? "").split(";")[0];
          }
          return response.data;
        });
        if (products) return finalizeProducts(products, cookieString, onProgress);
      } catch (error) {
        console.warn(`[happyland] GET pagination with ${sizeParameter} failed:`, error);
      }
    }

    try {
      const ajaxProducts = await crawlHttpPages(async (page) => {
        const body = new URLSearchParams({
          cateCd: "014008",
          page: String(page),
          listCount: String(PAGE_SIZE),
        });
        const { data } = await axios.post<string>(PRODUCT_LIST_AJAX_URL, body, {
          headers: {
            ...REQUEST_HEADERS,
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
          },
        });
        return data;
      });
      if (ajaxProducts)
        return finalizeProducts(ajaxProducts, cookieString, onProgress);
    } catch (error) {
      console.warn("[happyland] AJAX pagination failed:", error);
    }

    return finalizeProducts(
      await crawlWithPlaywright(),
      cookieString,
      onProgress
    );
  } catch (error) {
    console.error("[happyland] Crawl failed:", error);
    return [];
  }
}
