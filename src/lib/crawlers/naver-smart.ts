import axios from "axios";
import type { Page } from "playwright";
import type { RawProduct } from "../schemas/product";
import {
  getBrowser,
  getPage,
  normalizeImageUrl,
  parsePrice,
  STEALTH_SCRIPT,
} from "./utils";

const STORE_URL = "https://smartstore.naver.com/phytonutri";
const STORE_ID = "phytonutri";
const API_BASE_URL = "https://smartstore.naver.com/i/v2/channels";
const CATEGORY_API_BASE_URLS = [
  API_BASE_URL,
  "https://brand.naver.com/n/v2/channels",
];
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

async function extractChannelUidFromPage(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const state = (
      window as Window & {
        __PRELOADED_STATE__?: {
          channel?: {
            channelUid?: unknown;
          };
        };
      }
    ).__PRELOADED_STATE__;
    const channelUid = state?.channel?.channelUid;

    return typeof channelUid === "string" ? channelUid : null;
  });
}

async function fetchProductIdsWithPage(
  page: Page,
  channelUid: string
): Promise<number[]> {
  return page.evaluate(async ({ apiBaseUrl, channelUid }) => {
    const fetchIds = async (collection: string): Promise<unknown[]> => {
      const response = await fetch(
        `${apiBaseUrl}/${channelUid}/bs-product-collection/${collection}`
      );

      if (!response.ok) {
        throw new Error(
          `Failed to fetch ${collection}: ${response.status} ${response.statusText}`
        );
      }

      const data: unknown = await response.json();
      if (!Array.isArray(data)) {
        throw new Error(`Unexpected ${collection} response`);
      }

      return data;
    };

    const [bestProducts, newProducts] = await Promise.all([
      fetchIds("best-products"),
      fetchIds("new-products"),
    ]);

    return Array.from(
      new Set(
        [...bestProducts, ...newProducts].filter(
          (id): id is number => typeof id === "number" && Number.isFinite(id)
        )
      )
    );
  }, { apiBaseUrl: API_BASE_URL, channelUid });
}

async function fetchCategoryIdsWithPage(
  page: Page,
  channelUid: string
): Promise<Array<number | string>> {
  return page.evaluate(async ({ apiBaseUrls, channelUid }) => {
    const categoryIds = new Set<number | string>();
    const failures: string[] = [];

    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }

      if (!value || typeof value !== "object") {
        return;
      }

      const category = value as Record<string, unknown>;
      if (
        ((typeof category.id === "number" && Number.isFinite(category.id)) ||
          (typeof category.id === "string" && category.id.length > 0)) &&
        category.allProductCategory !== true
      ) {
        categoryIds.add(category.id);
      }

      Object.values(category).forEach(visit);
    };

    for (const apiBaseUrl of apiBaseUrls) {
      try {
        const response = await fetch(
          `${apiBaseUrl}/${channelUid}/categories/tree/DISPLAY`
        );

        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        visit((await response.json()) as unknown);
      } catch (error) {
        failures.push(
          `${apiBaseUrl}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (failures.length === apiBaseUrls.length) {
      throw new Error(`Failed to fetch category trees: ${failures.join("; ")}`);
    }

    return Array.from(categoryIds);
  }, { apiBaseUrls: CATEGORY_API_BASE_URLS, channelUid });
}

async function fetchCategoryProductsWithPage(
  page: Page,
  channelUid: string
): Promise<NaverSmartProduct[]> {
  const categoryIds = await fetchCategoryIdsWithPage(page, channelUid);
  const productsById = new Map<number, NaverSmartProduct>();

  for (const categoryId of categoryIds) {
    let categoryPage: Page | null = null;

    try {
      ({ page: categoryPage } = await getPage(
        `https://smartstore.naver.com/${STORE_ID}/category/${categoryId}`
      ));
      await categoryPage
        .waitForFunction(
          () => !!(window as any).__PRELOADED_STATE__?.categoryProducts,
          { timeout: 10000 }
        )
        .catch(() => null);
      const products = await categoryPage.evaluate(() => {
        const state = (
          window as Window & {
            __PRELOADED_STATE__?: {
              categoryProducts?: {
                simpleProducts?: NaverSmartProduct[];
              };
            };
          }
        ).__PRELOADED_STATE__;

        return state?.categoryProducts?.simpleProducts ?? [];
      });

      for (const product of products) {
        productsById.set(product.id, product);
      }
    } catch (error) {
      console.warn(
        `[naver-smart] Failed to crawl category ${categoryId}:`,
        error
      );
    } finally {
      await categoryPage?.context().close();
    }
  }

  return Array.from(productsById.values());
}

async function fetchProductsWithPage(
  page: Page,
  channelUid: string,
  productIds: number[]
): Promise<NaverSmartProduct[]> {
  return page.evaluate(
    async ({ apiBaseUrl, batchSize, channelUid, productIds }) => {
      const products: NaverSmartProduct[] = [];

      for (let index = 0; index < productIds.length; index += batchSize) {
        const batch = productIds.slice(index, index + batchSize);
        const response = await fetch(
          `${apiBaseUrl}/${channelUid}/simple-products?ids[]=${batch.join(",")}`
        );

        if (!response.ok) {
          throw new Error(
            `Failed to fetch product details: ${response.status} ${response.statusText}`
          );
        }

        const data: unknown = await response.json();
        if (!Array.isArray(data)) {
          throw new Error("Unexpected simple-products response");
        }

        products.push(...(data as NaverSmartProduct[]));
      }

      return products;
    },
    {
      apiBaseUrl: API_BASE_URL,
      batchSize: PRODUCT_BATCH_SIZE,
      channelUid,
      productIds,
    }
  );
}

async function crawlWithPlaywright(): Promise<RawProduct[] | null> {
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

    await page.goto(STORE_URL, { waitUntil: "networkidle", timeout: 30000 });

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

async function fetchChannelUidWithAxios(): Promise<string | null> {
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
        Referer: STORE_URL,
        "User-Agent": userAgent,
      };
      const response = await axios.get<string>(STORE_URL, {
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

async function fetchProductIdsWithAxios(channelUid: string): Promise<number[]> {
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: STORE_URL,
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
  productIds: number[]
): Promise<NaverSmartProduct[]> {
  const products: NaverSmartProduct[] = [];
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: STORE_URL,
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

async function crawlWithAxios(): Promise<RawProduct[]> {
  const channelUid = await fetchChannelUidWithAxios();
  if (!channelUid) {
    return [];
  }

  try {
    const productIds = await fetchProductIdsWithAxios(channelUid);
    const products = await fetchProductsWithAxios(channelUid, productIds);
    return mapProducts(products);
  } catch (error) {
    console.warn("[naver-smart] Axios fallback API request failed:", error);
    return [];
  }
}

export async function crawlNaverSmartStore(
  onProgress?: (productName: string) => void
): Promise<RawProduct[]> {
  console.log("[naver-smart] Starting crawl:", STORE_URL);

  try {
    const products = await crawlWithPlaywright();
    if (products !== null && products.length > 0) {
      products.forEach((product) => onProgress?.(product.name));
      console.log(`[naver-smart] Found ${products.length} products with Playwright`);
      return products;
    }
  } catch (error) {
    console.warn("[naver-smart] Playwright strategy failed:", error);
  }

  try {
    const products = await crawlWithAxios();
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
