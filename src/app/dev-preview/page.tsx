import { Container } from "@/components/Container";
import { BrandLockup } from "@/components/BrandMark";
import { MOCK_PREVIEW_CHAPTER_TOTAL } from "@/features/public-ui/fixtures/mock-content";
import { devPreviewChapterPath } from "@/features/public-ui/fixtures/preview-paths";

/**
 * MOCK_ONLY 开发预览索引。正式首页在 `/`。本组路由继续 noindex。
 */

interface PreviewEntry {
  href: string;
  title: string;
  note: string;
}

const ENTRIES: PreviewEntry[] = [
  {
    href: "/dev-preview/home",
    title: "首页",
    note: "通栏出血 Hero + 轮播（4 本有横版物料）+ 作品网格。移动 2 列 / 桌面 5 列。",
  },
  {
    href: "/dev-preview/home-fallback",
    title: "首页 · 无横版物料回落",
    note: "主推列表一本都没有横版主视觉时，整体落回封面编排版，页头回到实底。",
  },
  {
    href: "/dev-preview/novel",
    title: "小说详情",
    note: "可试读章节嵌入本页（D-12 定案），不建独立目录路由。",
  },
  {
    href: "/dev-preview/novel-sparse",
    title: "小说详情 · 极端稀疏",
    note: "无封面、无标签、无可试读章节。验证版面在最少字段下仍然成立。",
  },
  {
    href: devPreviewChapterPath(1),
    title: "章节阅读页",
    note: "阅读作用域 + 阅读设置面板；设置与阅读位置持久化，切章不整页刷新。",
  },
  {
    href: devPreviewChapterPath(MOCK_PREVIEW_CHAPTER_TOTAL),
    title: "章节阅读页 · 最后一章",
    note: "无下一章；正式阅读升为主动作。",
  },
  {
    href: "/dev-preview/collection",
    title: "语言 / 题材聚合",
    note: "与首页共用同一个卡片组件，不做第二套形态。",
  },
  {
    href: "/dev-preview/collection-empty",
    title: "聚合 · 空状态",
    note: "集合内没有作品时的形态。",
  },
  {
    href: "/dev-preview/unavailable",
    title: "下架状态",
    note: "稳定、克制、不制造错误感。",
  },
  {
    href: "/dev-preview/takedown",
    title: "撤回状态",
    note: "文案不同、视觉相同。HTTP 状态码由内容阶段的路由层负责。",
  },
  {
    href: "/dev-preview/status/not-found",
    title: "Root 404",
    note: "与 src/app/not-found.tsx 同一组件与文案。静态展示，不真的 404。",
  },
  {
    href: "/dev-preview/status/error",
    title: "Root error",
    note: "与 src/app/error.tsx 同一组件与文案。静态展示，不抛错；重试为空操作。",
  },
  {
    href: "/dev-preview/status/global-error",
    title: "Root global-error 面板",
    note: "与 global-error 同一面板。预览页不套第二层 html/body。",
  },
];

export default function PreviewIndexPage() {
  return (
    <Container as="main" className="py-16 md:py-24">
      <BrandLockup size={32} />

      <h1 className="mt-8 font-novel-serif text-3xl font-semibold tracking-tight text-novel-fg md:text-4xl">
        用户端页面壳预览
      </h1>

      <div className="mt-6 max-w-[62ch] rounded-novel-lg border border-novel-border bg-novel-bg-elevated p-5 text-sm leading-relaxed text-novel-fg-muted">
        <p className="font-medium text-novel-fg">MOCK_ONLY</p>
        <p className="mt-2">
          下列页面全部使用本地假数据，不连接任何接口、数据库或上游内容。
          这些地址是临时的开发预览入口，整体不可索引、不进 sitemap、不进 SEO 契约。
        </p>
        <p className="mt-2">视觉口径与站点暗色阅读界面一致。</p>
      </div>

      <ul className="mt-10 list-none border-t border-novel-border p-0">
        {ENTRIES.map((entry) => (
          <li key={entry.href} className="border-b border-novel-border">
            <a
              href={entry.href}
              className="block py-5 transition-colors hover:bg-novel-bg-elevated"
            >
              <span className="font-novel-serif text-lg text-novel-fg">{entry.title}</span>
              <span className="mt-1 block text-sm text-novel-fg-subtle">{entry.note}</span>
            </a>
          </li>
        ))}
      </ul>
    </Container>
  );
}
