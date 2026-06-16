import { NextRequest, NextResponse } from "next/server";
import { analyzeProducts } from "@/lib/ai/analyzer";
import { enrichWithLowestPrices } from "@/lib/crawlers/lowest-price";
import { crawlUniversal } from "@/lib/crawlers/universal";
import { closeBrowser, fetchHtmlWithFallback } from "@/lib/crawlers/utils";
import type { PartnerProductCreateInput } from "@/lib/schemas/product";

export interface CrawlResult {
  store: string;
  brand_name: string;
  url: string;
  products: PartnerProductCreateInput[];
  raw_count: number;
  success: boolean;
  error?: string;
}

const STORES = [
  {
    id: "naver-brand",
    name: "케피이 네이버 브랜드스토어",
    brand_name: "kefii",
    url: "https://brand.naver.com/kefii",
  },
  // naver-smart: headless 브라우저 탐지로 로그인 강제 — 쿠키 주입 없이는 우회 불가
  // {
  //   id: "naver-smart",
  //   name: "파이토누트리 스마트스토어",
  //   brand_name: "phytonutri",
  //   url: "https://smartstore.naver.com/phytonutri",
  // },
  {
    id: "happyland",
    name: "해피랜드몰",
    brand_name: "happylandmall",
    url: "https://m.happylandmall.com/",
  },
];

async function extractBrandName(url: string): Promise<string> {
  const hostname = new URL(url).hostname;
  try {
    const html = await fetchHtmlWithFallback(url);
    // og:site_name
    const ogSite = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1]
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)?.[1];
    if (ogSite?.trim()) return ogSite.trim();
    // <title> — take text before first separator (| - ::)
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
    if (title) {
      const parts = title.split(/[|\-:：]/);
      const candidate = parts[parts.length - 1].trim() || parts[0].trim();
      if (candidate.length >= 2 && candidate.length <= 30) return candidate;
    }
  } catch {
    // fall through to hostname
  }
  return hostname;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const storeId = searchParams.get("store") ?? "all";
  const limit = searchParams.get("limit") ? parseInt(searchParams.get("limit")!) : undefined;

  const targetStores =
    storeId === "all" ? STORES : STORES.filter((s) => s.id === storeId);

  if (targetStores.length === 0) {
    return NextResponse.json({ error: "Unknown store" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // client disconnected — ignore
        }
      };

      void (async () => {
        const results: CrawlResult[] = [];

        try {
          for (const store of targetStores) {
            try {
              console.log(`\n=== Crawling: ${store.name} ===`);
              const rawProducts = await crawlUniversal(
                store.url,
                (productName: string) =>
                  send({ type: "progress", stage: "crawl", productName })
              );
              console.log(`Raw products found: ${rawProducts.length}`);
              const limitedProducts = limit ? rawProducts.slice(0, limit) : rawProducts;

              send({
                type: "crawl_done",
                total: rawProducts.length,
                limited_total: limitedProducts.length,
              });

              send({ type: "lowest_price_start", total: limitedProducts.length });
              send({ type: "analyze_start", total: limitedProducts.length });

              const [enriched, analyzed] = await Promise.all([
                Promise.resolve<
                  Awaited<ReturnType<typeof enrichWithLowestPrices>>
                >([]),
                analyzeProducts(
                  limitedProducts,
                  store.brand_name,
                  10,
                  (productName) =>
                    send({ type: "progress", stage: "analyze", productName })
                ),
              ]);

              send({ type: "lowest_price_done" });

              const priceMap = new Map(
                enriched
                  .filter((p) => p.lowest_price_info)
                  .map((p) => [p.name, p.lowest_price_info!])
              );

              const merged = analyzed.map((product) => ({
                ...product,
                lowest_price: priceMap.get(product.name)?.price ?? null,
                lowest_price_source: priceMap.get(product.name)?.platform ?? null,
                lowest_price_collected_at:
                  priceMap.get(product.name)?.collected_at ?? null,
              }));
              console.log(`Analyzed products: ${analyzed.length}`);

              results.push({
                store: store.name,
                brand_name: store.brand_name,
                url: store.url,
                products: merged,
                raw_count: rawProducts.length,
                success: true,
              });
            } catch (err) {
              console.error(`Failed to crawl ${store.name}:`, err);
              results.push({
                store: store.name,
                brand_name: store.brand_name,
                url: store.url,
                products: [],
                raw_count: 0,
                success: false,
                error: err instanceof Error ? err.message : "Unknown error",
              });
            }
          }

          send({
            type: "done",
            result: {
              timestamp: new Date().toISOString(),
              total_products: results.reduce(
                (sum, result) => sum + result.products.length,
                0
              ),
              stores: results,
            },
          });
        } catch (err) {
          send({
            type: "error",
            error: err instanceof Error ? err.message : "Crawl failed",
          });
        } finally {
          await closeBrowser();
          try {
            controller.close();
          } catch {
            // 클라이언트가 먼저 연결을 끊은 경우 무시
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export async function POST(req: NextRequest) {
  const body: { url?: unknown } = await req.json();
  const url: string = typeof body.url === "string" ? body.url : "";

  if (!url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // client disconnected - ignore
        }
      };

      void (async () => {
        try {
          const brandName = await extractBrandName(url);
          const rawProducts = await crawlUniversal(url, (productName) =>
            send({ type: "progress", stage: "crawl", productName })
          );
          send({
            type: "crawl_done",
            total: rawProducts.length,
            limited_total: rawProducts.length,
          });

          send({ type: "lowest_price_start", total: rawProducts.length });
          send({ type: "analyze_start", total: rawProducts.length });

          const [enriched, analyzed] = await Promise.all([
            Promise.resolve<
              Awaited<ReturnType<typeof enrichWithLowestPrices>>
            >([]),
            analyzeProducts(rawProducts, brandName, 3, (productName) =>
              send({ type: "progress", stage: "analyze", productName })
            ),
          ]);

          send({ type: "lowest_price_done" });

          const priceMap = new Map(
            enriched
              .filter((product) => product.lowest_price_info)
              .map((product) => [product.name, product.lowest_price_info!])
          );

          const products = analyzed.map((product) => ({
            ...product,
            lowest_price: priceMap.get(product.name)?.price ?? null,
            lowest_price_source: priceMap.get(product.name)?.platform ?? null,
            lowest_price_collected_at:
              priceMap.get(product.name)?.collected_at ?? null,
          }));
          const result: CrawlResult = {
            store: brandName,
            brand_name: brandName,
            url,
            products,
            raw_count: rawProducts.length,
            success: true,
          };

          send({
            type: "done",
            result: {
              timestamp: new Date().toISOString(),
              total_products: products.length,
              stores: [result],
            },
          });
        } catch (err) {
          send({
            type: "error",
            error: err instanceof Error ? err.message : "Crawl failed",
          });
        } finally {
          await closeBrowser();
          try {
            controller.close();
          } catch {
            // client disconnected - ignore
          }
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
