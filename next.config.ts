import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone：只打包运行所需的最小产物，适配 Docker 部署
  output: "standalone",
  // poweredByHeader：不在响应头中暴露技术栈信息
  poweredByHeader: false,
  // 注：SEO bot 行为（如 htmlLimitedBots）留到 P2 决定，P1-04 骨架不预设。
};

export default nextConfig;
