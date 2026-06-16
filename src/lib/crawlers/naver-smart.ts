import axios from "axios";
import type { RawProduct } from "../schemas/product";
import {
  getBrowser,
  normalizeImageUrl,
  parsePrice,
  STEALTH_SCRIPT,
} from "./utils";

const API_BASE_URL = "https://smartstore.naver.com/i/v2/channels";
const PRODUCT_BATCH_SIZE = 50;
const CHANNEL_UID_PATTERN =
  /channelUid["']?\s*:\s*["']([A-Za-z0-9_-]{10,})["']/;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
];

interface NaverSmartProductOption {
  optionName1?: string;
  label?: string;
}

interface NaverSmartProduct {
  id: number;
  name: string;
  representativeImageUrl?: string;
  consumerPrice?: string | number | null;
  salePrice?: string | number | null;
  benefitPrice?: string | number | null;
  productStatusType?: string;
  stockQuantity?: number;
  optionCombinations?: NaverSmartProductOption[];
}

function extractChannelUidFromHtml(html: string): string | null {
  return html.match(CHANNEL_UID_PATTERN)?.[1] ?? null;
}

function uniqueProductIds(values: unknown[]): number[] {
  return Array.from(
    new Set(values.filter((id): id is number => typeof id === "number" && Number.isFinite(id)))
  );
}

function mapProducts(products: NaverSmartProduct[]): RawProduct[] {
  return products
    .filter(
      (product) =>
        product.productStatusType === "SALE" &&
        (product.stockQuantity ?? 1) > 0 &&
        typeof product.name === "string" &&
        product.name.length > 0
    )
    .map((product) => ({
      name: product.name,
      image_url: normalizeImageUrl(product.representativeImageUrl ?? ""),
      consumer_price: parsePrice(product.consumerPrice ?? product.salePrice ?? 0),
      sales_price: parsePrice(product.benefitPrice ?? product.salePrice ?? 0),
      options:
        product.optionCombinations
          ?.map((option) => option.optionName1 ?? option.label ?? "")
          .filter(Boolean) ?? [],
    }));
}

async function crawlWithPlaywright(storeUrl: string): Promise<RawProduct[] | null> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    extraHTTPHeaders: {
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  await context.addInitScript(STEALTH_SCRIPT);
  const page = await context.newPage();
  const capturedProducts = new Map<number, NaverSmartProduct>();

  try {
    page.on("response", async (response) => {
      const url = response.url();
      if (
        !url.includes("/v2/channels/") ||
        ![
          "simpleProducts",
          "simple-products",
          "categoryProducts",
          "category/",
        ].some((path) => url.includes(path))
      ) {
        return;
      }

      try {
        const json = (await response.json()) as
          | NaverSmartProduct[]
          | {
              simpleProducts?: NaverSmartProduct[];
              products?: NaverSmartProduct[];
            };
        const items = Array.isArray(json)
          ? json
          : (json?.simpleProducts ?? json?.products ?? []);

        for (const item of items) {
          if (typeof item.id === "number") {
            capturedProducts.set(item.id, item);
          }
        }
      } catch {
        // Ignore matching responses that do not contain JSON product data.
      }
    });

    await page.goto(storeUrl, { waitUntil: "networkidle", timeout: 30000 });

    try {
      const categoryTabs = await page
        .locator('[class*="category"] a, [class*="Category"] a')
        .all();

      for (const categoryTab of categoryTabs.slice(0, 20)) {
        await categoryTab.click();
        await page.waitForTimeout(1500);
      }
    } catch (error) {
      console.warn("[naver-smart] Failed to click category tabs:", error);
    }
  } finally {
    await page.context().close();
  }

  if (capturedProducts.size === 0) {
    return null;
  }

  return mapProducts(Array.from(capturedProducts.values()));
}

async function fetchChannelUidWithAxios(storeUrl: string): Promise<string | null> {
  const failures: string[] = [];

  for (const userAgent of USER_AGENTS) {
    await new Promise((resolve) =>
      setTimeout(resolve, 200 + Math.random() * 300)
    );

    try {
      const headers = {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        Referer: storeUrl,
        "User-Agent": userAgent,
      };
      const response = await axios.get<string>(storeUrl, {
        headers,
        timeout: 30000,
      });
      const channelUid = extractChannelUidFromHtml(response.data);

      if (channelUid) {
        return channelUid;
      }

      failures.push("channelUid was absent from the HTML");
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  console.warn(
    `[naver-smart] Axios fallback could not extract channelUid: ${failures.join("; ")}`
  );
  return null;
}

async function fetchProductIdsWithAxios(
  channelUid: string,
  storeUrl: string
): Promise<number[]> {
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: storeUrl,
    "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
  };
  const [bestResponse, newResponse] = await Promise.all([
    axios.get<unknown>(
      `${API_BASE_URL}/${channelUid}/bs-product-collection/best-products`,
      { headers, timeout: 30000 }
    ),
    axios.get<unknown>(
      `${API_BASE_URL}/${channelUid}/bs-product-collection/new-products`,
      { headers, timeout: 30000 }
    ),
  ]);

  const bestProducts = Array.isArray(bestResponse.data) ? bestResponse.data : [];
  const newProducts = Array.isArray(newResponse.data) ? newResponse.data : [];
  return uniqueProductIds([...bestProducts, ...newProducts]);
}

async function fetchProductsWithAxios(
  channelUid: string,
  productIds: number[],
  storeUrl: string
): Promise<NaverSmartProduct[]> {
  const products: NaverSmartProduct[] = [];
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: storeUrl,
    "User-Agent": USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
  };

  for (let index = 0; index < productIds.length; index += PRODUCT_BATCH_SIZE) {
    await new Promise((resolve) =>
      setTimeout(resolve, 200 + Math.random() * 300)
    );

    const batch = productIds.slice(index, index + PRODUCT_BATCH_SIZE);
    const response = await axios.get<unknown>(
      `${API_BASE_URL}/${channelUid}/simple-products?ids[]=${batch.join(",")}`,
      { headers, timeout: 30000 }
    );

    if (!Array.isArray(response.data)) {
      throw new Error("Unexpected simple-products response");
    }

    products.push(...(response.data as NaverSmartProduct[]));
  }

  return products;
}

async function crawlWithAxios(storeUrl: string): Promise<RawProduct[]> {
  const channelUid = await fetchChannelUidWithAxios(storeUrl);
  if (!channelUid) {
    return [];
  }

  try {
    const productIds = await fetchProductIdsWithAxios(channelUid, storeUrl);
    const products = await fetchProductsWithAxios(channelUid, productIds, storeUrl);
    return mapProducts(products);
  } catch (error) {
    console.warn("[naver-smart] Axios fallback API request failed:", error);
    return [];
  }
}

export async function crawlNaverSmartStore(
  storeUrl: string,
  onProgress?: (productName: string) => void
): Promise<RawProduct[]> {
  const STORE_URL = storeUrl;

  console.log("[naver-smart] Starting crawl:", STORE_URL);

  try {
    const products = await crawlWithPlaywright(STORE_URL);
    if (products !== null && products.length > 0) {
      products.forEach((product) => onProgress?.(product.name));
      console.log(`[naver-smart] Found ${products.length} products with Playwright`);
      return products;
    }
  } catch (error) {
    console.warn("[naver-smart] Playwright strategy failed:", error);
  }

  try {
    const products = await crawlWithAxios(STORE_URL);
    if (products.length > 0) {
      products.forEach((product) => onProgress?.(product.name));
      console.log(`[naver-smart] Found ${products.length} products with axios`);
      return products;
    }
  } catch (error) {
    console.warn("[naver-smart] Axios strategy failed:", error);
  }

  return [];
}
