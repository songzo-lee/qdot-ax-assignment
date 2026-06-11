import axios from 'axios';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { chromium } from 'playwright';
import type { RawProduct } from '../../schemas/product';
import type { CrawlerAdapter } from './types';

const MIN_PRODUCTS = 3;
const HTML_PROMPT_LIMIT = 8000;
const COMMON_PRODUCT_SELECTORS = [
  '[data-product-id]',
  '.product-item',
  '.product-card',
  '[class*=product][class*=item]',
] as const;

interface ProductSelectors {
  containerSelector?: string;
  nameSelector?: string;
  priceSelector?: string;
  imageSelector?: string;
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePrice(value: string): number {
  return parseInt(value.replace(/[^0-9]/g, ''), 10) || 0;
}

function absoluteUrl(value: string, pageUrl: string): string {
  if (!value) return '';

  try {
    return new URL(value, pageUrl).href;
  } catch {
    return '';
  }
}

function normalizeProduct(product: RawProduct, pageUrl: string): RawProduct {
  return {
    ...product,
    name: product.name.trim(),
    image_url: absoluteUrl(product.image_url, pageUrl),
    consumer_price: parsePrice(String(product.consumer_price)),
    sales_price: parsePrice(String(product.sales_price)),
    url: product.url ? absoluteUrl(product.url, pageUrl) : undefined,
  };
}

function normalizeProducts(
  products: RawProduct[],
  pageUrl: string,
): RawProduct[] {
  return products
    .map((product) => normalizeProduct(product, pageUrl))
    .filter((product) => product.name.length > 0 && product.sales_price > 0);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function parseShopifyProducts(data: unknown, pageUrl: string): RawProduct[] {
  if (!isRecord(data) || !Array.isArray(data.products)) return [];

  const products: RawProduct[] = [];
  for (const item of data.products) {
    if (!isRecord(item)) continue;

    const variants = Array.isArray(item.variants) ? item.variants : [];
    const firstVariant = variants.find(isRecord);
    const images = Array.isArray(item.images) ? item.images : [];
    const firstImage = images.find(isRecord);
    const salesPrice = parsePrice(stringValue(firstVariant?.price));
    const consumerPrice =
      parsePrice(stringValue(firstVariant?.compare_at_price)) || salesPrice;
    const handle = stringValue(item.handle);

    products.push({
      name: stringValue(item.title),
      image_url: stringValue(firstImage?.src),
      consumer_price: consumerPrice,
      sales_price: salesPrice,
      url: handle ? `/products/${handle}` : undefined,
    });
  }

  return normalizeProducts(products, pageUrl);
}

function parseWooCommerceProducts(data: unknown, pageUrl: string): RawProduct[] {
  if (!Array.isArray(data)) return [];

  const products: RawProduct[] = [];
  for (const item of data) {
    if (!isRecord(item)) continue;

    const images = Array.isArray(item.images) ? item.images : [];
    const firstImage = images.find(isRecord);
    const salesPrice =
      parsePrice(stringValue(item.sale_price)) ||
      parsePrice(stringValue(item.price)) ||
      parsePrice(stringValue(item.regular_price));
    const consumerPrice =
      parsePrice(stringValue(item.regular_price)) || salesPrice;

    products.push({
      name: stringValue(item.name),
      image_url: stringValue(firstImage?.src),
      consumer_price: consumerPrice,
      sales_price: salesPrice,
      description: stringValue(item.short_description),
      category: Array.isArray(item.categories)
        ? item.categories
            .filter(isRecord)
            .map((category) => stringValue(category.name))
            .filter(Boolean)
            .join(', ')
        : undefined,
      url: stringValue(item.permalink) || undefined,
    });
  }

  return normalizeProducts(products, pageUrl);
}

function firstText(
  product: cheerio.Cheerio<AnyNode>,
  selectors: readonly string[],
): string {
  for (const selector of selectors) {
    const text = product.find(selector).first().text().replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

function firstAttribute(
  product: cheerio.Cheerio<AnyNode>,
  selector: string,
  attributes: readonly string[],
): string {
  const element = product.find(selector).first();
  for (const attribute of attributes) {
    const value = element.attr(attribute)?.trim();
    if (value) return value;
  }
  return '';
}

function parseHtmlProducts(
  html: string,
  pageUrl: string,
  selectors: ProductSelectors,
): RawProduct[] {
  if (!selectors.containerSelector) return [];

  const $ = cheerio.load(html);
  const products: RawProduct[] = [];

  $(selectors.containerSelector).each((_, element) => {
    const product = $(element);
    const name = selectors.nameSelector
      ? firstText(product, [selectors.nameSelector])
      : firstText(product, [
          '[data-product-title]',
          '.product-title',
          '.product-name',
          '[class*=title]',
          '[class*=name]',
          'h2',
          'h3',
        ]);
    const priceText = selectors.priceSelector
      ? firstText(product, [selectors.priceSelector])
      : firstText(product, [
          '[data-product-price]',
          '.price',
          '[class*=price]',
        ]);
    const imageSelector = selectors.imageSelector || 'img';
    const imageUrl = firstAttribute(product, imageSelector, [
      'src',
      'data-src',
      'data-lazy-src',
      'srcset',
    ]).split(/\s+/)[0];
    const productUrl = firstAttribute(product, 'a[href]', ['href']);
    const price = parsePrice(priceText);

    products.push({
      name,
      image_url: imageUrl,
      consumer_price: price,
      sales_price: price,
      url: productUrl || undefined,
    });
  });

  return normalizeProducts(products, pageUrl);
}

function parseSelectorResponse(value: string): ProductSelectors {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};

    return {
      containerSelector:
        typeof parsed.containerSelector === 'string'
          ? parsed.containerSelector
          : undefined,
      nameSelector:
        typeof parsed.nameSelector === 'string' ? parsed.nameSelector : undefined,
      priceSelector:
        typeof parsed.priceSelector === 'string'
          ? parsed.priceSelector
          : undefined,
      imageSelector:
        typeof parsed.imageSelector === 'string'
          ? parsed.imageSelector
          : undefined,
    };
  } catch {
    return {};
  }
}

async function detectSelectors(html: string): Promise<ProductSelectors> {
  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model: 'gpt-5.4-nano',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: `Analyze this e-commerce HTML and identify CSS selectors for repeated product cards. Return only valid JSON with this exact shape: {"containerSelector":"","nameSelector":"","priceSelector":"","imageSelector":""}. Selectors must be usable with Cheerio, and the name, price, and image selectors must be relative to the container selector.\n\nHTML:\n${html.slice(0, HTML_PROMPT_LIMIT)}`,
        },
      ],
    });
    const responseText = response.choices[0].message.content ?? '';
    return parseSelectorResponse(responseText);
  } catch (error) {
    console.warn('[generic] LLM selector detection failed:', error);
    return {};
  }
}

function reportProgress(
  products: RawProduct[],
  onProgress?: (productName: string) => void,
): RawProduct[] {
  for (const product of products) onProgress?.(product.name);
  return products;
}

export const genericAdapter = {
  name: 'generic',

  detect(_url: string, _html?: string): boolean {
    return true;
  },

  async crawl(
    url: string,
    onProgress?: (productName: string) => void,
  ): Promise<RawProduct[]> {
    const origin = new URL(url).origin;
    let html = '';

    // Stage 1: common APIs and HTML product-card patterns.
    try {
      const pageResponse = await axios.get<string>(url);
      html = pageResponse.data;

      try {
        const shopifyResponse = await axios.get<unknown>(
          new URL('/products.json?limit=250', origin).href,
        );
        const products = parseShopifyProducts(shopifyResponse.data, url);
        if (products.length >= MIN_PRODUCTS) {
          return reportProgress(products, onProgress);
        }
      } catch (error) {
        console.warn('[generic] Shopify API crawl failed:', error);
      }

      try {
        const wooCommerceResponse = await axios.get<unknown>(
          new URL('/wp-json/wc/v2/products?per_page=100', origin).href,
        );
        const products = parseWooCommerceProducts(wooCommerceResponse.data, url);
        if (products.length >= MIN_PRODUCTS) {
          return reportProgress(products, onProgress);
        }
      } catch (error) {
        console.warn('[generic] WooCommerce API crawl failed:', error);
      }

      for (const containerSelector of COMMON_PRODUCT_SELECTORS) {
        const products = parseHtmlProducts(html, url, { containerSelector });
        if (products.length >= MIN_PRODUCTS) {
          return reportProgress(products, onProgress);
        }
      }
    } catch (error) {
      console.warn('[generic] Common-pattern crawl failed:', error);
    }

    // Stage 2: use Claude to identify selectors in the fetched HTML.
    try {
      if (html) {
        const selectors = await detectSelectors(html);
        const products = parseHtmlProducts(html, url, selectors);
        if (products.length >= MIN_PRODUCTS) {
          return reportProgress(products, onProgress);
        }
      }
    } catch (error) {
      console.warn('[generic] LLM-assisted crawl failed:', error);
    }

    // Stage 3: render the page, then repeat LLM-assisted selector detection.
    try {
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle' });
        const renderedHtml = await page.content();
        const selectors = await detectSelectors(renderedHtml);
        const products = parseHtmlProducts(renderedHtml, url, selectors);
        return reportProgress(products, onProgress);
      } finally {
        await browser.close();
      }
    } catch (error) {
      console.warn('[generic] Playwright crawl failed:', error);
      return [];
    }
  },
} satisfies CrawlerAdapter;

export default genericAdapter;
