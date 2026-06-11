import axios from 'axios';
import type { RawProduct } from '../schemas/product';
import { cafe24Adapter } from './adapters/cafe24';
import { genericAdapter } from './adapters/generic';
import { firstmallAdapter } from './adapters/firstmall';
import { godomallAdapter } from './adapters/godomall';
import { naverBrandAdapter } from './adapters/naver-brand';
import { naverSmartAdapter } from './adapters/naver-smart';
import type { CrawlerAdapter } from './adapters/types';
import { happylandAdapter } from './happyland';

const ADAPTERS: CrawlerAdapter[] = [
  naverBrandAdapter,
  naverSmartAdapter,
  happylandAdapter,
  godomallAdapter,
  firstmallAdapter,
  cafe24Adapter,
  genericAdapter,
];

const DETECT_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

export async function crawlUniversal(
  url: string,
  onProgress?: (productName: string) => void,
): Promise<RawProduct[]> {
  let html: string | undefined;
  try {
    const response = await axios.get<string>(url, {
      headers: { 'User-Agent': DETECT_USER_AGENT },
      timeout: 15000,
    });
    html = response.data;
  } catch {
    // Some URLs may not serve HTML; adapters fall back to URL-only detection.
  }

  for (const adapter of ADAPTERS) {
    if (await adapter.detect(url, html)) {
      return adapter.crawl(url, onProgress);
    }
  }

  throw new Error('No adapter found for URL: ' + url);
}
