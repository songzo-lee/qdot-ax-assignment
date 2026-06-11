import OpenAI from "openai";
import { PartnerProductSchema, CATEGORY_GROUPS, type PartnerProductCreateInput, type RawProduct } from "../schemas/product";

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY 환경변수가 설정되지 않았습니다. env.example을 참고하여 .env.local을 생성하세요.");
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `당신은 이커머스 상품 데이터를 분석하여 큐닷 파트너 상품 제안서 형식으로 정규화하는 전문가입니다.
주어진 상품 정보를 분석하여 JSON 형식으로 정확하게 출력하세요.

카테고리 그룹 선택 기준:
- 유아 식품: 이유식, 유아음료, 유아과자, 아기용 식품
- 유아 건강: 유아 영양제, 유아 건강보조식품, 성장보조제
- 유아 놀이 교육: 장난감, 교육용품, 학습교재
- 유아 생활: 기저귀, 유아의류, 유아용품, 아기위생용품
- 기타 식품: 성인용 건강식품, 일반 식품
- 기타 여행: 여행용품, 여행서비스
- 기타 리빙: 생활용품, 인테리어, 홈케어

hashtags는 상품의 핵심 키워드를 #없이 3-7개 추출하세요.
usp는 상품의 핵심 차별점을 한 문장으로 작성하세요 (최대 100자).
discount_rate는 입력에 discount_rate 값이 제공된 경우 그 값을 그대로 사용하고, 없으면 (consumer_price - sales_price) / consumer_price * 100으로 계산하세요.`;

const USER_PROMPT_TEMPLATE = (product: RawProduct, brandName: string) => `
다음 상품 정보를 큐닷 파트너 상품 제안서 형식으로 변환해주세요:

브랜드명: ${brandName}
상품명: ${product.name}
이미지 URL: ${product.image_url || "없음"}
정가: ${product.consumer_price}원
판매가: ${product.sales_price}원
${product.discount_rate !== undefined ? `할인율: ${product.discount_rate}%\n` : ""}옵션(각 줄이 독립된 옵션 타입, 쉼표로 구분된 값들은 모두 포함):
${product.options && product.options.length > 0 ? product.options.map((o, i) => `  옵션${i + 1}: ${o}`).join("\n") : "  없음"}
상품 설명: ${product.description || "없음"}
카테고리: ${product.category || "없음"}

다음 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "brand_name": "브랜드명",
  "name": "상품명",
  "image_url": "이미지URL",
  "option1": null 또는 "옵션1의 모든 값 (레이블 제외, 값만 쉼표 구분 원형 그대로. 예: '색상: L/블루, 핑크' → 'L/블루, 핑크')",
  "option2": null 또는 "옵션2의 모든 값 (레이블 제외, 값만 쉼표 구분 원형 그대로. 예: '치수: 80, 90, 100' → '80, 90, 100')",
  "consumer_price": 정가숫자,
  "sales_price": 판매가숫자,
  "discount_rate": 할인율숫자,
  "hashtags": ["태그1", "태그2", ...],
  "usp": "핵심 차별점",
  "category_group": ["카테고리1"] // 아래 목록 중 1개 이상 선택: ${CATEGORY_GROUPS.join(', ')}
}`;

export async function analyzeProduct(
  product: RawProduct,
  brandName: string
): Promise<PartnerProductCreateInput | null> {
  try {
    const userPrompt = USER_PROMPT_TEMPLATE(product, brandName);
    const response = await client.chat.completions.create({
      model: "gpt-5.4-nano",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    });
    const text = response.choices[0].message.content ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");

    const parsed = JSON.parse(jsonMatch[0]);

    // 이미지 URL이 없거나 유효하지 않을 경우 원본 데이터 사용
    if (!parsed.image_url || parsed.image_url === "없음") {
      parsed.image_url = product.image_url || "https://via.placeholder.com/400";
    }

    // URL 형식이 아닌 경우 플레이스홀더로 대체
    try {
      new URL(parsed.image_url);
    } catch {
      parsed.image_url = "https://via.placeholder.com/400";
    }

    // hashtags 보정: 빈 배열이면 상품명에서 키워드 추출
    if (!Array.isArray(parsed.hashtags) || parsed.hashtags.length === 0) {
      parsed.hashtags = product.name
        .replace(/[\[\]()]/g, ' ')
        .split(/\s+/)
        .filter((w: string) => w.length >= 2)
        .slice(0, 5);
      if (parsed.hashtags.length === 0) parsed.hashtags = ['상품'];
    }

    // option1/2 레이블 접두사 제거 (예: "색상: L/블루" → "L/블루")
    const LABEL_PREFIX_RE = /^[가-힣a-zA-Z/\s]{1,6}:\s*/;
    if (typeof parsed.option1 === "string") parsed.option1 = parsed.option1.replace(LABEL_PREFIX_RE, "");
    if (typeof parsed.option2 === "string") parsed.option2 = parsed.option2.replace(LABEL_PREFIX_RE, "");

    // category_group 보정: 허용 목록에 없는 값 제거, 빈 배열이면 '기타 리빙' 기본값
    const VALID = CATEGORY_GROUPS as readonly string[];
    if (Array.isArray(parsed.category_group)) {
      parsed.category_group = parsed.category_group.filter((v: string) => VALID.includes(v));
    }
    if (!Array.isArray(parsed.category_group) || parsed.category_group.length === 0) {
      parsed.category_group = ['기타 리빙'];
    }

    // 최저가는 크롤링으로 채움 — AI가 알 수 없으므로 null 고정
    parsed.lowest_price = null;
    parsed.lowest_price_source = null;
    parsed.lowest_price_collected_at = null;

    return PartnerProductSchema.parse(parsed);
  } catch (err) {
    console.error(`[analyzer] Failed to analyze product "${product.name}":`, err);
    return null;
  }
}

export async function analyzeProducts(
  products: RawProduct[],
  brandName: string,
  concurrency = 3,
  onProgress?: (productName: string) => void
): Promise<PartnerProductCreateInput[]> {
  const { default: pLimit } = await import("p-limit");
  const limit = pLimit(concurrency);

  const tasks = products.map((product) =>
    limit(async () => {
      try {
        return await analyzeProduct(product, brandName);
      } finally {
        onProgress?.(product.name);
      }
    })
  );
  const results = await Promise.all(tasks);
  return results.filter((r): r is PartnerProductCreateInput => r !== null);
}
