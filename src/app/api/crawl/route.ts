import { NextRequest, NextResponse } from "next/server";
import { crawlNaverBrandStore } from "@/lib/crawlers/naver-brand";
import { crawlNaverSmartStore } from "@/lib/crawlers/naver-smart";
import { crawlHappyland } from "@/lib/crawlers/happyland";
import { analyzeProducts } from "@/lib/ai/analyzer";
import { closeBrowser } from "@/lib/crawlers/utils";
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
    crawler: crawlNaverBrandStore,
  },
  {
    id: "naver-smart",
    name: "파이토누트리 스마트스토어",
    brand_name: "phytonutri",
    url: "https://smartstore.naver.com/phytonutri",
    crawler: crawlNaverSmartStore,
  },
  {
    id: "happyland",
    name: "해피랜드몰",
    brand_name: "happylandmall",
    url: "https://m.happylandmall.com/",
    crawler: crawlHappyland,
  },
];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const storeId = searchParams.get("store") ?? "all";

  const targetStores =
    storeId === "all" ? STORES : STORES.filter((s) => s.id === storeId);

  if (targetStores.length === 0) {
    return NextResponse.json({ error: "Unknown store" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      void (async () => {
        const results: CrawlResult[] = [];

        try {
          for (const store of targetStores) {
            try {
              console.log(`\n=== Crawling: ${store.name} ===`);
              const rawProducts = await store.crawler((productName) =>
                send({ type: "progress", stage: "crawl", productName })
              );
              console.log(`Raw products found: ${rawProducts.length}`);

              const analyzed = await analyzeProducts(
                rawProducts,
                store.brand_name,
                3,
                (productName) =>
                  send({ type: "progress", stage: "analyze", productName })
              );
              console.log(`Analyzed products: ${analyzed.length}`);

              results.push({
                store: store.name,
                brand_name: store.brand_name,
                url: store.url,
                products: analyzed,
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
          controller.close();
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
  const body = await req.json();
  const url: string = body.url ?? "";

  if (!url) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  // URL로 스토어 자동 감지
  let store = STORES.find((s) => url.includes(new URL(s.url).hostname));
  if (!store && url.includes("brand.naver.com")) store = STORES[0];
  if (!store && url.includes("smartstore.naver.com")) store = STORES[1];
  if (!store && url.includes("happylandmall.com")) store = STORES[2];

  if (!store) {
    return NextResponse.json({ error: "Unsupported store URL" }, { status: 400 });
  }

  try {
    const rawProducts = await store.crawler();
    const analyzed = await analyzeProducts(rawProducts, store.brand_name);
    await closeBrowser();

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      store: store.name,
      url: store.url,
      raw_count: rawProducts.length,
      products: analyzed,
    });
  } catch (err) {
    await closeBrowser();
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Crawl failed" },
      { status: 500 }
    );
  }
}
