import type { RawProduct } from '../../schemas/product';

export interface CrawlerAdapter {
  name: string;
  detect(url: string, html?: string): boolean | Promise<boolean>;
  crawl(url: string, onProgress?: (productName: string) => void): Promise<RawProduct[]>;
}
