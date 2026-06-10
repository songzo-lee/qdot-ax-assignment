import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "큐닷 AX — 브랜드몰 상품 분석기",
  description: "브랜드몰 URL → AI 분석 → 큐닷 상품제안서 자동 생성",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
