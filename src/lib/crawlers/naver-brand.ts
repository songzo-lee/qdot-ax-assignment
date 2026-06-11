import type { Page } from "playwright";
import type { RawProduct } from "../schemas/product";
import { getBrowser, getPage } from "./utils";

const STORE_URL = "https://brand.naver.com/kefii";
const API_BASE_URL = "https://brand.naver.com/n/v2/channels";
const PRODUCT_BATCH_SIZE = 50;
const PRODUCT_OPTION_CONCURRENCY = 10;

interface NaverBrandProduct {
  id: number;
  name: string;
  salePrice: number;
  representativeImageUrl: string;
  optionCombinations?: Array<{
    optionName1?: string;
    optionName2?: string;
    stockQuantity?: number;
  }>;
  productStatusType?: string;
  stockQuantity?: number;
  benefitsView?: {
    discountedSalePrice?: number;
    discountedRatio?: number;
  };
}

async function extractChannelUid(page: Page): Promise<string> {
  const channelUid = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const match =
      html.match(/["']channelUid["']\s*:\s*["']([^"']+)["']/) ??
      html.match(/\\"channelUid\\"\s*:\s*\\"([^\\"]+)\\"/);

    return match?.[1] ?? null;
  });

  if (!channelUid) {
    throw new Error("Unable to extract channelUid from the brand store page");
  }

  return channelUid;
}

async function fetchProductIds(
  page: Page,
  channelUid: string
): Promise<Array<number | string>> {
  return page.evaluate(async ({ apiBaseUrl, channelUid }) => {
    const response = await fetch(
      `${apiBaseUrl}/${channelUid}/categories/tree/DISPLAY`
    );

    if (!response.ok) {
      throw new Error(
        `Failed to fetch category tree: ${response.status} ${response.statusText}`
      );
    }

    const data: unknown = await response.json();
    const categoryIds = new Set<number | string>();

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
          (typeof category.id === "number" && Number.isFinite(category.id)) ||
          (typeof category.id === "string" && category.id.length > 0)
        ) {
          categoryIds.add(category.id);
        }

      Object.values(category).forEach(visit);
    };

    visit(data);
    return Array.from(categoryIds);
  }, { apiBaseUrl: API_BASE_URL, channelUid });
}

async function fetchFallbackProducts(
  page: Page,
  channelUid: string
): Promise<NaverBrandProduct[]> {
  return page.evaluate(
    async ({ apiBaseUrl, batchSize, channelUid }) => {
      const fetchCollection = async (collection: string): Promise<number[]> => {
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

        return data.filter(
          (id): id is number => typeof id === "number" && Number.isFinite(id)
        );
      };

      const [bestProductIds, newProductIds] = await Promise.all([
        fetchCollection("best-products"),
        fetchCollection("new-products"),
      ]);
      const productIds = Array.from(
        new Set([...bestProductIds, ...newProductIds])
      );
      const products: NaverBrandProduct[] = [];

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

        products.push(...(data as NaverBrandProduct[]));
      }

      return products;
    },
    {
      apiBaseUrl: API_BASE_URL,
      batchSize: PRODUCT_BATCH_SIZE,
      channelUid,
    }
  );
}

async function fetchCategoryProducts(
  page: Page,
  channelUid: string
): Promise<NaverBrandProduct[]> {
  const categoryIds = await fetchProductIds(page, channelUid);
  const productsById = new Map<number, NaverBrandProduct>();

  for (const categoryId of categoryIds) {
    let categoryPage: Page | null = null;

    try {
      ({ page: categoryPage } = await getPage(
        `${STORE_URL}/category/${categoryId}`
      ));
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
      const products = await categoryPage.evaluate(() => {
        const state = (
          window as Window & {
            __PRELOADED_STATE__?: {
              categoryProducts?: {
                simpleProducts?: NaverBrandProduct[];
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
        `[naver-brand] Failed to crawl category ${categoryId}:`,
        error
      );
    } finally {
      await categoryPage?.context().close();
    }
  }

  return Array.from(productsById.values());
}

async function fetchProductOptions(
  page: Page,
  channelUid: string,
  products: NaverBrandProduct[]
): Promise<NaverBrandProduct[]> {
  void page;
  void channelUid;

  const { default: pLimit } = await import("p-limit");
  const limit = pLimit(PRODUCT_OPTION_CONCURRENCY);

  type OptionCombination = {
    optionName1?: string;
    optionName2?: string;
  };

  const findInObject = (value: unknown): OptionCombination[] | null => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findInObject(item);
        if (found) return found;
      }
      return null;
    }

    if (!value || typeof value !== "object") {
      return null;
    }

    const object = value as Record<string, unknown>;
    const optionCombinations = object.optionCombinations;
    if (
      Array.isArray(optionCombinations) &&
      optionCombinations.length > 0 &&
      optionCombinations.every(
        (option) =>
          option !== null &&
          typeof option === "object" &&
          "optionName1" in option
      )
    ) {
      return optionCombinations as OptionCombination[];
    }

    for (const nestedValue of Object.values(object)) {
      const found = findInObject(nestedValue);
      if (found) return found;
    }

    return null;
  };

  return Promise.all(
    products.map((product) =>
      limit(async () => {
        const browser = await getBrowser();
        const context = await browser.newContext({
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          locale: "ko-KR",
        });

        try {
          const productPage = await context.newPage();

          let capturedOptions: ReturnType<typeof findInObject> = null;
          productPage.on("response", async (response) => {
            const url = response.url();
            if (
              !url.includes("/channels/") ||
              !url.includes("/products/") ||
              !url.includes("withWindow=false")
            ) return;
            try {
              const data: unknown = await response.json();
              const found = findInObject(data);
              if (found) capturedOptions = found;
            } catch { /* ignore */ }
          });

          await productPage.goto(`${STORE_URL}/products/${product.id}`, {
            waitUntil: "networkidle",
            timeout: 15000,
          }).catch(() => { /* timeout은 무시하고 캡처된 값 사용 */ });

          return capturedOptions
            ? { ...product, optionCombinations: capturedOptions }
            : product;
        } catch {
          return product;
        } finally {
          await context.close();
        }
      })
    )
  );
}

function mapProducts(products: NaverBrandProduct[]): RawProduct[] {
  const productsById = new Map<number, NaverBrandProduct>();

  for (const product of products) {
    productsById.set(product.id, product);
  }

  return Array.from(productsById.values())
    .filter((product) => product.productStatusType === "SALE" && (product.stockQuantity ?? 1) > 0)
    .map((product) => {
      const inStockCombinations = product.optionCombinations?.filter(
        (c) => (c.stockQuantity ?? 1) > 0
      ) ?? [];
      const optionName1Values = Array.from(
        new Set(
          inStockCombinations
            .map((combination) => combination.optionName1)
            .filter((value): value is string => Boolean(value))
        )
      );
      const optionName2Values = Array.from(
        new Set(
          inStockCombinations
            .map((combination) => combination.optionName2)
            .filter((value): value is string => Boolean(value))
        )
      );
      const options: string[] = [];

      if (optionName2Values.length > 0) {
        options.push(optionName1Values.join(","));
        options.push(optionName2Values.join(","));
      } else if (optionName1Values.length > 0) {
        options.push(optionName1Values.join(","));
      }

      const discountRate = product.benefitsView?.discountedRatio;
      return {
        name: product.name,
        image_url: product.representativeImageUrl,
        consumer_price: product.salePrice,
        sales_price: product.benefitsView?.discountedSalePrice ?? product.salePrice,
        ...(discountRate !== undefined && { discount_rate: discountRate }),
        options,
      };
    });
}

export async function crawlNaverBrandStore(
  onProgress?: (productName: string) => void
): Promise<RawProduct[]> {
  console.log("[naver-brand] Starting crawl:", STORE_URL);
  const { page } = await getPage(STORE_URL);

  try {
    const channelUid = await extractChannelUid(page);
    let productDetails: NaverBrandProduct[] = [];

    try {
      productDetails = await fetchCategoryProducts(page, channelUid);
    } catch (error) {
      console.warn("[naver-brand] Category strategy failed:", error);
    }

    if (productDetails.length === 0) {
      console.warn(
        "[naver-brand] Category pages returned no products, using collection fallback"
      );
      productDetails = await fetchFallbackProducts(page, channelUid);
    }

    productDetails = await fetchProductOptions(page, channelUid, productDetails);
    const products = mapProducts(productDetails);
    products.forEach((product) => onProgress?.(product.name));

    console.log(`[naver-brand] Found ${products.length} products`);
    return products;
  } catch (error) {
    console.error("[naver-brand] Crawl failed:", error);
    return [];
  } finally {
    await page.context().close();
  }
}
