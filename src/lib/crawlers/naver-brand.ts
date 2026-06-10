import type { Page } from "playwright";
import type { RawProduct } from "../schemas/product";
import { getPage } from "./utils";

const STORE_URL = "https://brand.naver.com/kefii";
const API_BASE_URL = "https://brand.naver.com/n/v2/channels";
const PRODUCT_BATCH_SIZE = 50;

interface NaverBrandProductOption {
  optionName1?: string;
  label?: string;
  [key: string]: unknown;
}

interface NaverBrandProduct {
  id: number;
  name: string;
  salePrice: number;
  consumerPrice: number | null;
  benefitPrice: number | null;
  representativeImageUrl: string;
  productStatusType?: string;
  stockQuantity?: number;
  optionCombinations?: NaverBrandProductOption[];
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

function mapProducts(products: NaverBrandProduct[]): RawProduct[] {
  const productsById = new Map<number, NaverBrandProduct>();

  for (const product of products) {
    productsById.set(product.id, product);
  }

  return Array.from(productsById.values())
    .filter((product) => product.productStatusType === "SALE" && (product.stockQuantity ?? 1) > 0)
    .map((product) => ({
      name: product.name,
      image_url: product.representativeImageUrl,
      consumer_price: product.consumerPrice ?? product.salePrice,
      sales_price: product.benefitPrice ?? product.salePrice,
      options:
        product.optionCombinations
          ?.map((option) => option.optionName1 ?? option.label ?? "")
          .filter(Boolean) ?? [],
    }));
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
