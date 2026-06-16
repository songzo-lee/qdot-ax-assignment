import type { RawProduct } from '../schemas/product';

const SOLD_OUT_RE =
  /(?:품절|일시\s*품절|재고\s*없음|재고없음|sold\s*out|soldout|out\s*of\s*stock|out\s*of\s*stock)/i;

function combineProductText(product: Pick<RawProduct, 'name' | 'description' | 'category' | 'url' | 'options'>): string {
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

export function filterSoldOutProducts(products: RawProduct[]): RawProduct[] {
  return products.filter((product) => !isSoldOutProduct(product));
}
