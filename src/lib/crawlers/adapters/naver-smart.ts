import { crawlNaverSmartStore } from '../naver-smart';
import type { CrawlerAdapter } from './types';

export const naverSmartAdapter: CrawlerAdapter = {
  name: 'naver-smart',
  detect(url) {
    return url.includes('smartstore.naver.com');
  },
  crawl(url, onProgress) {
    return crawlNaverSmartStore(url, onProgress);
  },
};
