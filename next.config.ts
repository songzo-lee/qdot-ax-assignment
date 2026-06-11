import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright", "playwright-extra", "puppeteer-extra-plugin-stealth", "cheerio"],
  turbopack: {
    root: __dirname,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.naver.com" },
      { protocol: "https", hostname: "*.happylandmall.com" },
      { protocol: "https", hostname: "*.pstatic.net" },
    ],
  },
};

export default nextConfig;
