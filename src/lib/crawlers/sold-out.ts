import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import type { RawProduct } from '../schemas/product';

const SOLD_OUT_RE =
  /(?:품절|판매\s*중지|일시\s*품절|sold\s*out|soldout|out\s*of\s*stock|outofstock)/i;
const SOLD_OUT_SUFFIX_RE =
  /\s*(?:[-–—:·]?\s*)?(?:[\(\[\{]?\s*(?:품절|판매\s*중지|일시\s*품절|sold\s*out|soldout|out\s*of\s*stock|outofstock)\s*[\)\]\}]?)\s*$/i;

function combineProductText(
  product: Pick<RawProduct, 'name' | 'description' | 'category' | 'url' | 'options'>,
): string {
  return [
    product.name,
    product.description ?? '',
    product.category ?? '',
    product.url ?? '',
    ...(product.options ?? []),
  ]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isSoldOutProduct(
  product: Pick<RawProduct, 'name' | 'description' | 'category' | 'url' | 'options'>,
): boolean {
  return SOLD_OUT_RE.test(combineProductText(product));
}

function hasSoldOutElementSignal(element?: Element): boolean {
  if (!element) return false;

  const attribs = element.attribs ?? {};
  if ('disabled' in attribs) return true;

  const ariaDisabled = attribs['aria-disabled'];
  if (
    typeof ariaDisabled === 'string' &&
    /^(?:true|1|disabled)$/i.test(ariaDisabled.trim())
  ) {
    return true;
  }

  const className = attribs.class ?? '';
  if (
    className &&
    /(?:^|\s)(?:sold[-_ ]?out|soldout|out[-_ ]?of[-_ ]?stock|out[-_ ]?stock|disabled|unavailable)(?:\s|$)/i.test(
      className,
    )
  ) {
    return true;
  }

  const dataSoldout = attribs['data-soldout'] ?? attribs['data-sold-out'];
  if (typeof dataSoldout === 'string') {
    const normalized = dataSoldout.trim();
    if (normalized && !/^(?:false|0|no|off)$/i.test(normalized)) {
      return true;
    }
  } else if (dataSoldout !== undefined) {
    return true;
  }

  return false;
}

export function isOptionValueSoldOut(
  text: string,
  element?: Element,
  _?: cheerio.CheerioAPI,
): boolean {
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  if (!normalizedText) return false;

  if (SOLD_OUT_RE.test(normalizedText)) return true;
  return hasSoldOutElementSignal(element);
}

export function stripSoldOutSuffix(text: string): string {
  return text.replace(SOLD_OUT_SUFFIX_RE, '').replace(/\s+/g, ' ').trim();
}

export function filterSoldOutProducts(products: RawProduct[]): RawProduct[] {
  return products.filter((product) => !isSoldOutProduct(product));
}
