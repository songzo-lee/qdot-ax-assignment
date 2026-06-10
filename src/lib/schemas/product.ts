import { z } from "zod";

export const CATEGORY_GROUPS = [
  "유아 식품",
  "유아 건강",
  "유아 놀이 교육",
  "유아 생활",
  "기타 식품",
  "기타 여행",
  "기타 리빙",
] as const;

export const PartnerProductSchema = z.object({
  brand_name: z.string(),
  name: z.string(),
  image_url: z.string().url(),
  option1: z.string().nullable(),
  option2: z.string().nullable(),
  consumer_price: z.number().positive(),
  sales_price: z.number().positive(),
  lowest_price: z.number().positive().nullable(),
  discount_rate: z.number().min(0).max(100),
  hashtags: z.array(z.string()).min(1).max(10),
  usp: z.string(),
  category_group: z.array(z.enum(CATEGORY_GROUPS)).min(1),
});

export type PartnerProductCreateInput = z.infer<typeof PartnerProductSchema>;

export interface RawProduct {
  name: string;
  image_url: string;
  consumer_price: number;
  sales_price: number;
  options?: string[];
  description?: string;
  category?: string;
  url?: string;
}
