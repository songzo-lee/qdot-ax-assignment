import { chromium, type Browser, type Page } from "playwright";

let browserInstance: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });
  }
  return browserInstance;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

export async function getPage(url: string): Promise<{ page: Page; content: string }> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  const content = await page.content();

  return { page, content };
}

export function extractPreloadedState(html: string): Record<string, unknown> | null {
  try {
    const match = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (match) return JSON.parse(match[1]);
  } catch {
    // fall through
  }
  return null;
}

export function normalizeImageUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http")) return url;
  return url;
}

export function parsePrice(raw: string | number): number {
  if (typeof raw === "number") return raw;
  return parseInt(String(raw).replace(/[^0-9]/g, ""), 10) || 0;
}
