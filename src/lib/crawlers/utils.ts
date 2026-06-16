import axios from "axios";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

let browserInstance: Browser | null = null;

const MOBILE_FETCH_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1";
const DESKTOP_FETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function shouldRetryWithoutMobileUserAgent(error: unknown): boolean {
  const err = error as {
    code?: unknown;
    hostname?: unknown;
    message?: unknown;
    cause?: { code?: unknown; hostname?: unknown; message?: unknown };
  };

  const codes = [err?.code, err?.cause?.code].filter(Boolean).map(String);
  const hostnames = [err?.hostname, err?.cause?.hostname]
    .filter(Boolean)
    .map(String);
  const messages = [err?.message, err?.cause?.message].filter(Boolean).map(String);

  return (
    codes.some((code) => code === "ENOTFOUND" || code === "EAI_AGAIN") ||
    hostnames.some((hostname) => hostname.startsWith("m.")) ||
    messages.some(
      (message) =>
        /getaddrinfo\s+ENOTFOUND/i.test(message) || /\bm\.[a-z0-9.-]+\b/i.test(message),
    )
  );
}

async function fetchHtml(url: string, userAgent: string, referer?: string): Promise<string> {
  const response = await axios.get<string>(url, {
    headers: {
      "User-Agent": userAgent,
      ...(referer ? { Referer: referer } : {}),
    },
    timeout: 15000,
  });
  return response.data;
}

export interface FetchedHtmlResult {
  html: string;
  finalUrl: string;
}

async function fetchHtmlAndUrl(
  url: string,
  userAgent: string,
  referer?: string,
): Promise<FetchedHtmlResult> {
  const response = await axios.get<string>(url, {
    headers: {
      "User-Agent": userAgent,
      ...(referer ? { Referer: referer } : {}),
    },
    timeout: 15000,
  });

  const responseRequest = response.request as
    | { res?: { responseUrl?: string }; responseURL?: string }
    | undefined;
  const finalUrl =
    responseRequest?.res?.responseUrl ??
    responseRequest?.responseURL ??
    url;

  return {
    html: response.data,
    finalUrl,
  };
}

export async function fetchHtmlWithFallback(
  url: string,
  options: { referer?: string } = {},
): Promise<string> {
  try {
    return await fetchHtml(url, MOBILE_FETCH_USER_AGENT, options.referer);
  } catch (error) {
    if (shouldRetryWithoutMobileUserAgent(error)) {
      return fetchHtml(url, DESKTOP_FETCH_USER_AGENT, options.referer);
    }
    throw error;
  }
}

export async function fetchHtmlWithFallbackAndUrl(
  url: string,
  options: { referer?: string } = {},
): Promise<FetchedHtmlResult> {
  try {
    return await fetchHtmlAndUrl(url, MOBILE_FETCH_USER_AGENT, options.referer);
  } catch (error) {
    if (shouldRetryWithoutMobileUserAgent(error)) {
      return fetchHtmlAndUrl(url, DESKTOP_FETCH_USER_AGENT, options.referer);
    }
    throw error;
  }
}

export async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--disable-dev-shm-usage",
        "--disable-extensions",
      ],
    });
  }
  return browserInstance!;
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

export const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'languages', {
    get: () => ['ko-KR', 'ko', 'en-US', 'en'],
  });
`;

export async function getPage(url: string): Promise<{ page: Page; content: string }> {
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
  const page = await context.newPage();
  await page.addInitScript(STEALTH_SCRIPT);

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  const content = await page.content();

  return { page, content };
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
