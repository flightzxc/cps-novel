import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ReaderSettingsProvider } from "@/features/public-ui/chapter/ReaderSettingsProvider";
import {
  READER_FONT_SIZES,
  READER_LINE_HEIGHTS,
  READER_MEASURES,
  READER_SETTINGS_STORAGE_KEY,
} from "@/features/public-ui/chapter/reader-settings";

export const metadata: Metadata = {
  // 根布局与 dev-preview 布局都已经声明过；这里第三次显式声明，是因为章节页是
  // 唯一带动态段的预览路由，将来最可能被误当成"正式页面"接上索引。
  robots: { index: false, follow: false },
};

/**
 * 章节预览路由的外壳。
 *
 * 🔴 **仍然是 DEV_PREVIEW**：不是正式生产章节 URL。noindex/nofollow、
 * 不设 self-canonical、不进 sitemap、不进 IndexNow、不写入正式 SEO URL 契约。
 * 正式章节页（每章独立 URL + self-canonical + 可被收录）要等 D-8 裁定语种段
 * 之后单独建，届时只替换路由层，阅读器组件不动。
 *
 * 这一层存在的理由只有一个：**它在 `[chapterNumber]` 之上**。
 * App Router 切换同一布局下的兄弟路由时不重挂 layout，所以挂在这里的
 * ReaderSettingsProvider 能让阅读设置跨章存活。挂到页面里就做不到。
 */
export default function ChapterPreviewLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/*
        防闪脚本：必须在阅读区绘制之前同步执行，因此是一段阻塞式内联脚本，
        且放在 children 之前。

        解决的问题：服务端不知道读者存过什么，阅读区只能先按默认值渲染；改过设置
        的读者会在补水前看到一帧默认外观。配色闪一下已经难看，**排版闪一下是整页
        回流**，更明显，而且会让阅读位置按错误的字号被测量。这段脚本在补水之前
        就把偏好写到 <html> 上：主题走属性、排版三项走 CSS 变量，globals.css 里
        对应的规则与 fallback 层据此提前生效。补水后由 ReaderSettingsProvider
        保持两者同值，之后阅读区的内联样式接管。

        跟随系统 + 默认排版不需要它——那本来就是服务端渲染出的样子，不存在闪烁。
        脚本自身整体 try/catch：存储被禁用时静默放弃，绝不能因此挡住正文。
      */}
      <script
        dangerouslySetInnerHTML={{
          __html: [
            "try{",
            `var s=localStorage.getItem(${JSON.stringify(READER_SETTINGS_STORAGE_KEY)});`,
            "if(s){",
            "var p=JSON.parse(s),r=document.documentElement,",
            `F=${JSON.stringify(READER_FONT_SIZES)},`,
            `L=${JSON.stringify(READER_LINE_HEIGHTS)},`,
            `M=${JSON.stringify(READER_MEASURES)};`,
            // 主题：只回放手动覆盖。system 不写属性——那本来就该由媒体查询决定。
            'if(p.theme==="light"||p.theme==="dark"){r.setAttribute("data-reader-pref-theme",p.theme)}',
            // 排版：档位下标必须是本表内的合法整数才回放，避免被手改过的存储
            // 把 undefined 写进 CSS 变量。真正的收敛在补水后由 normalizeReaderSettings 做。
            'if(F[p.fontSizeIndex]){r.style.setProperty("--reader-pref-font-size",F[p.fontSizeIndex])}',
            'if(L[p.lineHeightIndex]){r.style.setProperty("--reader-pref-line-height",L[p.lineHeightIndex])}',
            'if(M[p.measureIndex]){r.style.setProperty("--reader-pref-measure",M[p.measureIndex])}',
            "}",
            "}catch(e){}",
          ].join(""),
        }}
      />
      <ReaderSettingsProvider>{children}</ReaderSettingsProvider>
    </>
  );
}
