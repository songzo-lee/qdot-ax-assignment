import { NextRequest, NextResponse } from "next/server";
import { crawlNaverBrandStore } from "@/lib/crawlers/naver-brand";
import { crawlNaverSmartStore } from "@/lib/crawlers/naver-smart";
import { crawlHappyland } from "@/lib/crawlers/happyland";
import { closeBrowser } from "@/lib/crawlers/utils";

const STORES: Record<string, { name: string; crawler: () => Promise<unknown[]> }> = {
  "naver-brand": { name: "네이버 브랜드스토어 (kefii)", crawler: crawlNaverBrandStore },
  "naver-smart": { name: "스마트스토어 (phytonutri)", crawler: crawlNaverSmartStore },
  "happyland": { name: "해피랜드몰", crawler: crawlHappyland },
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const storeId = searchParams.get("store") ?? "naver-brand";

  const store = STORES[storeId];
  if (!store) {
    return NextResponse.json({ error: "Unknown store. Use: naver-brand | naver-smart | happyland" }, { status: 400 });
  }

  try {
    const products = await store.crawler();
    await closeBrowser();
    return NextResponse.json({
      store: store.name,
      count: products.length,
      products,
    });
  } catch (err) {
    await closeBrowser();
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
