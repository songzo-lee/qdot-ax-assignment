"use client";

import { useState } from "react";
import type { CrawlResult } from "./api/crawl/route";
import type { PartnerProductCreateInput } from "@/lib/schemas/product";
import styles from "./page.module.css";

const STORES = [
  { id: "all", label: "전체 스토어" },
  { id: "naver-brand", label: "네이버 브랜드스토어 (kefii)" },
  { id: "naver-smart", label: "스마트스토어 (phytonutri)" },
  { id: "happyland", label: "해피랜드몰" },
];

interface CrawlResponse {
  timestamp: string;
  total_products: number;
  stores: CrawlResult[];
}

interface ProgressState {
  stage: "crawl" | "analyze";
  productNames: string[];
}

type CrawlEvent =
  | { type: "progress"; stage: ProgressState["stage"]; productName: string }
  | { type: "done"; result: CrawlResponse }
  | { type: "error"; error: string };

export default function Home() {
  const [selectedStore, setSelectedStore] = useState("all");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CrawlResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);

  function handleCrawl() {
    setLoading(true);
    setError(null);
    setResult(null);
    setProgress({ stage: "crawl", productNames: [] });

    const eventSource = new EventSource(
      `/api/crawl?store=${encodeURIComponent(selectedStore)}`
    );
    let completed = false;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as CrawlEvent;

        if (data.type === "progress") {
          setProgress((current) => ({
            stage: data.stage,
            productNames: [
              data.productName,
              ...(current?.productNames ?? []),
            ].slice(0, 5),
          }));
          return;
        }

        completed = true;
        eventSource.close();
        setProgress(null);
        setLoading(false);

        if (data.type === "done") {
          setResult(data.result);
        } else {
          setError(data.error);
        }
      } catch {
        completed = true;
        eventSource.close();
        setError("크롤링 실패");
        setProgress(null);
        setLoading(false);
      }
    };

    eventSource.onerror = () => {
      if (completed) return;
      completed = true;
      eventSource.close();
      setError("크롤링 실패");
      setProgress(null);
      setLoading(false);
    };
  }

  function downloadJson() {
    if (!result) return;
    const allProducts = result.stores.flatMap((s) => s.products);
    const blob = new Blob([JSON.stringify(allProducts, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `qdot-products-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const allProducts = result?.stores.flatMap((s) => s.products) ?? [];

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <div className={styles.logo}>큐닷 AX</div>
        <h1 className={styles.title}>브랜드몰 상품 분석기</h1>
        <p className={styles.subtitle}>
          브랜드몰을 크롤링하여 AI로 분석하고 파트너 상품제안서를 자동 생성합니다
        </p>
      </header>

      <section className={styles.controls}>
        <div className={styles.controlRow}>
          <select
            value={selectedStore}
            onChange={(e) => setSelectedStore(e.target.value)}
            className={styles.select}
          >
            {STORES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            onClick={handleCrawl}
            disabled={loading}
            className={styles.crawlBtn}
          >
            {loading ? "분석 중..." : "크롤링 시작"}
          </button>
          {result && (
            <button onClick={downloadJson} className={styles.downloadBtn}>
              JSON 다운로드
            </button>
          )}
        </div>

        {loading && progress && (
          <div className={styles.progress}>
            <div className={styles.spinner} />
            <div>
              <strong>
                {progress.stage === "crawl" ? "크롤링 중..." : "AI 분석 중..."}
              </strong>
              {progress.productNames.map((productName, index) => (
                <div key={`${productName}-${index}`}>{productName}</div>
              ))}
            </div>
          </div>
        )}
      </section>

      {error && <div className={styles.error}>{error}</div>}

      {result && (
        <section className={styles.results}>
          <div className={styles.summary}>
            <div className={styles.summaryCard}>
              <span className={styles.summaryNum}>{result.total_products}</span>
              <span className={styles.summaryLabel}>분석된 상품</span>
            </div>
            <div className={styles.summaryCard}>
              <span className={styles.summaryNum}>
                {result.stores.filter((s) => s.success).length}
              </span>
              <span className={styles.summaryLabel}>성공한 스토어</span>
            </div>
            <div className={styles.summaryCard}>
              <span className={styles.summaryNum}>
                {result.stores.reduce((sum, s) => sum + s.raw_count, 0)}
              </span>
              <span className={styles.summaryLabel}>원본 상품 수</span>
            </div>
          </div>

          {result.stores.map((store) => (
            <div key={store.store} className={styles.storeSection}>
              <div className={styles.storeHeader}>
                <h2 className={styles.storeName}>{store.store}</h2>
                <div className={styles.storeStats}>
                  <span className={store.success ? styles.badge : styles.badgeError}>
                    {store.success ? "성공" : "실패"}
                  </span>
                  <span className={styles.muted}>
                    {store.products.length}/{store.raw_count}개 분석
                  </span>
                </div>
              </div>
              {store.error && <p className={styles.storeError}>{store.error}</p>}
              <div className={styles.productGrid}>
                {store.products.map((product, i) => (
                  <ProductCard
                    key={`${store.store}-${i}`}
                    product={product}
                    expanded={expandedProduct === `${store.store}-${i}`}
                    onToggle={() =>
                      setExpandedProduct(
                        expandedProduct === `${store.store}-${i}`
                          ? null
                          : `${store.store}-${i}`
                      )
                    }
                  />
                ))}
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

function ProductCard({
  product,
  expanded,
  onToggle,
}: {
  product: PartnerProductCreateInput;
  expanded: boolean;
  onToggle: () => void;
}) {
  const discountRate = Math.round(product.discount_rate);

  return (
    <div className={styles.productCard} onClick={onToggle}>
      <div className={styles.productImageWrapper}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={product.image_url}
          alt={product.name}
          className={styles.productImage}
          onError={(e) => {
            (e.target as HTMLImageElement).src = "https://via.placeholder.com/200x200?text=No+Image";
          }}
        />
        {discountRate > 0 && (
          <span className={styles.discountBadge}>{discountRate}% OFF</span>
        )}
      </div>
      <div className={styles.productInfo}>
        <div className={styles.categoryTag}>{product.category_group}</div>
        <h3 className={styles.productName}>{product.name}</h3>
        <p className={styles.productUsp}>{product.usp}</p>
        <div className={styles.priceRow}>
          {product.consumer_price !== product.sales_price && (
            <span className={styles.originalPrice}>
              {product.consumer_price.toLocaleString()}원
            </span>
          )}
          <span className={styles.salesPrice}>
            {product.sales_price.toLocaleString()}원
          </span>
        </div>
        {product.lowest_price && (
          <div className={styles.lowestPrice}>
            최저가: {product.lowest_price.toLocaleString()}원
          </div>
        )}
        <div className={styles.hashtags}>
          {product.hashtags.map((tag) => (
            <span key={tag} className={styles.hashtag}>
              #{tag}
            </span>
          ))}
        </div>
        {expanded && (
          <div className={styles.rawJson}>
            <pre>{JSON.stringify(product, null, 2)}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
