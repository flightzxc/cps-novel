/**
 * 口令码模式（v0.6.0，PlotNovel）的前台文案——**只有英语**。
 *
 * 为什么不放进 15 语的 `messages/` 目录：口令码模式只对剧场配置里 `codeModeLocales` 列出的语种生效，而登记时
 * 它就是 `["en"]`——PlotNovel 的书全是英语，就绪规则（`isPromoReady`）已经把其它语种的书挡在门外，读者永远
 * 看不到这些文案的其它语种版本。放进 `messages/` 会触发整套完整性门禁（`tests/ui/messages-completeness.test.ts`
 * 要求 14 个非英语目录逐键齐全且不是英文原文），而 Owner 的要求是"只加英语、不要自己翻译其它语种"。
 *
 * 已知限制与触发条件（写进 `docs/adr/ADR-V060-PLOTNOVEL-CODE-THEATER.md`）：PlotNovel 出现非英语书时，
 * **先补译文，再把语种加进该剧场的 `codeModeLocales`**——到那时把本文件的内容搬进 `messages/` 并过完整性门禁。
 * 在那之前，如果有人先改了配置，这些文案会以英语原样出现在其它语种的页面上（功能完整，只是没有翻译）。
 *
 * App 名来自剧场配置（`appDisplayName`，缺省 "PlotNovel"），所有文案都以函数形式接收它，不写死品牌。
 */

/** 剧场配置里没写 `appDisplayName` 时的 App 名（前台文案与 `theater-promo-mode.ts` 共用这一个常量）。 */
export const DEFAULT_CODE_MODE_APP_NAME = "PlotNovel";

export type CodeModeCopy = Readonly<{
  /** 书页 / 章节页 / 底部浮条按钮。 */
  readOnApp: string;
  /** 按钮下的一行小字。 */
  readOnAppHint: string;
  interstitial: Readonly<{
    pageTitle: string;
    backToBook: string;
    nowReading: string;
    availableInApp: string;
    heading: string;
    /** 电脑布局的一句话说明（手机布局用三步）。 */
    intro: string;
    codeLabel: string;
    copyCode: string;
    copied: string;
    stepsLabel: string;
    steps: readonly [string, string, string];
    appStore: string;
    googlePlay: string;
    /** 两个商店链接都没配时的兜底一句话。 */
    searchInStore: string;
    disclaimer: (siteName: string) => string;
  }>;
}>;

export function codeModeCopy(appName: string): CodeModeCopy {
  return {
    readOnApp: `Read on ${appName} App`,
    readOnAppHint: "Free app · your book code is on the next page",
    interstitial: {
      pageTitle: "Continue reading in the app",
      backToBook: "Back to book",
      nowReading: "Now reading",
      availableInApp: `Available in the ${appName} app`,
      heading: `Continue reading on ${appName}`,
      intro: `This book is read in the free ${appName} app. Copy your book code, open the app, and paste it into Search.`,
      codeLabel: "Your book code",
      copyCode: "Copy code",
      copied: "Copied",
      stepsLabel: "How to read this book",
      steps: [
        "Copy the code above.",
        `Get the free ${appName} app.`,
        "Open the app, tap Search and paste the code. The book opens right away.",
      ],
      appStore: "Download on the App Store",
      googlePlay: "Get it on Google Play",
      searchInStore: `Search "${appName}" in your app store`,
      disclaimer: (siteName: string) => `${appName} is a third-party app. ${siteName} may earn a commission.`,
    },
  };
}
