import { Container } from "@/components/Container";
import { BrandLockup } from "@/components/BrandMark";

/**
 * 开发预览索引。
 *
 * 🔴 这不是首页。正式 URL 结构尚未冻结（语种段的取舍仍是待决项），本轮所有屏幕
 * 都实现为与路由无关的功能组件，由下面这组临时路由承载。整站不可索引。
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
    note: "主推位（不使用宽幅 banner）+ 作品网格。移动 2 列 / 桌面 5 列。",
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
    href: "/dev-preview/chapter",
    title: "章节阅读页",
    note: "阅读作用域 + 阅读设置面板（可切换，本轮不持久化）。",
  },
  {
    href: "/dev-preview/chapter-last",
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
          正式 URL 结构尚未冻结，这些地址是临时的开发预览入口，整体不可索引、
          不进 sitemap、不进 SEO 契约。
        </p>
        <p className="mt-2">
          视觉口径见 <code className="text-novel-primary">docs/p1/P1_10_VISUAL_DIRECTION.md</code>。
        </p>
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
