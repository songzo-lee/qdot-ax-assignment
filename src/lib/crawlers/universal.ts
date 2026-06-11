import type { RawProduct } from '../schemas/product';
import { genericAdapter } from './adapters/generic';
import { godomallAdapter } from './adapters/godomall';
import { naverBrandAdapter } from './adapters/naver-brand';
import { naverSmartAdapter } from './adapters/naver-smart';
import type { CrawlerAdapter } from './adapters/types';

const ADAPTERS: CrawlerAdapter[] = [
  naverBrandAdapter,
  naverSmartAdapter,
  godomallAdapter,
  genericAdapter,
];

export async function crawlUniversal(
  url: string,
  onProgress?: (productName: string) => void,
): Promise<RawProduct[]> {
  for (const adapter of ADAPTERS) {
    if (await adapter.detect(url)) {
      return adapter.crawl(url, onProgress);
    }
  }

  throw new Error('No adapter found for URL: ' + url);
}
