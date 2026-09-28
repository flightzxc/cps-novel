# 运营前端与 SEO 优化第一轮 · 文案清单

- 日期：2026-09-29
- 分支：`feat/ops-seo-ui-round1`，基线 `origin/release/v0.5.3-2026-09-28 @ 46cea2e`
- 本单只写英文原文（`src/lib/locale/messages/en.ts`）。其它 14 个语种文件：
  - **C 项修改的 17 个既有键**：值保持不动（旧译文），由后续单独的翻译单处理（Sonnet 翻译，第三方验收）。
  - **A3/A4/B1 新增的 10 个键**：先用英文原文占位（满足 `messages-completeness` 门禁的 key 集合一致性要求），同样等翻译单处理。占位期间登记在 `tests/ui/messages-completeness.test.ts` 的 `ALLOW_SAME_AS_EN` 里，翻译落地后应移除对应条目。
  - **本分支在翻译完成前不得合并发布**（交接文档原话）。

## 一、C 项：去掉"本站/原平台/预览"，17 个键

范围：`src/lib/locale/messages/en.ts`。判定标准（Owner 2026-09-29 拍板"按运营原文做"）：去掉"本网站/this site"、"原网站/原平台/original platform/source platform"、"预览/preview"及同义表述，按本站就是官方站点处理。

全量重新审计（不是复用评估文档的估计值）：审计方法是对 `en.ts` 做大小写不敏感 grep（`this site` / `original platform` / `source platform` / `preview`），逐条核实是出现在字符串**值**里还是仅出现在键名/注释里。**实际命中 17 个键**（评估文档估计"约 17 个，例如…等"，本次审计确认为恰好 17 个，含评估文档examples 列表里没有点名的 `blog.unpublishedBody`）。

| # | 键 | 出现位置/语境 | 旧英文 | 新英文 | 长度/字符限制 |
|---|---|---|---|---|---|
| 1 | `nav.footerNote` | 页脚静态说明行（`SiteFooter`，不是 `SiteSetting.footer_disclaimer_text` 那个后台可编辑字段） | `This site offers free preview chapters. The full story is on the original platform.` | `New chapters are added regularly.` | 页脚单行，建议 ≤60 字符（原两句改一句，为了让句数门禁对本键直接跳过比较，不强制改写 14 语种） |
| 2 | `home.startPreview` | 首页 Hero/FeaturedNovel 的"开始试读"按钮 | `Start preview` | `Start reading` | 按钮标签，≤20 字符 |
| 3 | `novel.previewCount` | 详情页元信息行"{count} 章可试读" | `{count} preview chapters` | `{count} chapters available` | 元信息行内联文本，含 `{count}` 插值，≤30 字符（不含插值） |
| 4 | `novel.startPreview` | 详情页行动区主按钮 | `Start preview` | `Start reading` | 按钮标签，≤20 字符 |
| 5 | `novel.previewChapters` | A3 上线后已不再被组件引用（原章节区块标题，现改用 `chapterListTitle`），仅为保持其它 14 语种 key 集合不变而保留 | `Preview chapters` | `Chapters` | 已停用，无展示位置限制 |
| 6 | `novel.previewChaptersDescription` | A3 上线后已不再被组件引用（原章节区块的单复数说明，现改用 `chapterListCount`），仅为保持 key 集合不变而保留；ICU plural（`one`/`other`），参数 `{count}` | `{count, plural, one {1 preview chapter on this site, provided by the original platform.} other {{count} preview chapters on this site, all provided by the original platform.}}` | `{count, plural, one {1 chapter free to read now.} other {{count} chapters free to read now.}}` | 已停用，无展示位置限制；分支需保持 `one`/`other` 两个 CLDR 类别 |
| 7 | `novel.noPreviewChapters` | 已停用（发布与 Preview 解耦后"零章节"整块不渲染，`PreviewChapterList.tsx` 直接返回 null），仅为保持 key 集合不变而保留 | `This book has no preview chapters yet.` | `No chapters to read yet.` | 已停用，无展示位置限制 |
| 8 | `chapter.lastPreviewChapter` | 章节页 `ChapterPager` 末章位提示（替代"下一章"按钮） | `This is the last preview chapter` | `This is the last chapter` | 行内提示文字，≤40 字符，句式与相邻的 `chapter.firstChapter`（"This is the first chapter"）保持一致 |
| 9 | `chapter.previewPosition` | 章节页 `BookAttributionBar` 试读进度指示（"第 N / 共 M"） | `Preview {index} / {total}` | `{index} / {total}` | 行内小字，含 `{index}`/`{total}` 两个插值 |
| 10 | `chapter.endOfPreview` | 章节页章末提示（最后一章可试读时） | `That's the end of the preview on this site.` | `That's everything available right now.` | 单句提示，≤60 字符 |
| 11 | `chapter.remainingOnOrigin` | 章节页章末提示（非最后一章时的次级说明） | `Later chapters continue on the original platform.` | `Keep reading to continue the story.` | 单句提示，≤60 字符 |
| 12 | `collection.allWorksDescription` | 全部作品聚合页说明 | `Works currently available to read on this site.` | `Works currently available to read.` | SEO description 候选来源之一，≤80 字符 |
| 13 | `unavailable.unpublishedBody` | 下架（unpublished）状态页正文 | `It has been removed from this site. If it returns, this address will still work.`（2 句） | `If it returns, this address will still work.`（1 句） | 正文段落；原两句改一句，去掉的那句由同一屏的 `unavailable.unpublishedTitle`（"This book is temporarily unavailable"）承担"为什么不可用"这层含义 |
| 14 | `unavailable.takedownBody` | 撤回（takedown）状态页正文 | `At the rights holder's request, this site no longer offers this book.` | `At the rights holder's request, this book is no longer offered here.` | 单句正文，≤80 字符 |
| 15 | `blog.listDescription` | 博客列表页说明 | `Articles and updates from this site.` | `Articles and updates.` | SEO description 候选来源之一，≤60 字符 |
| 16 | `blog.unpublishedBody` | 博客文章下架状态正文（与 13 同结构、独立键） | `It has been removed from this site. If it returns, this address will still work.`（2 句） | `If it returns, this address will still work.`（1 句） | 同 13 |
| 17 | `meta.siteDescription` | 全站兜底 meta description（`SiteSetting.siteDescription` 为空时的回退） | `Discover novels and read preview chapters.` | `Discover novels and start reading free chapters.` | SEO meta description，≤160 字符 |

说明：# 5/6/7 三个键在 A3 折中方案上线后已经不再被任何组件引用（原来的"可试读章节"区块整体换成了新的"章节列表"区块，见下表新增键）。没有直接删除它们、也没有改动其它 14 个语种文件里对应的值，是为了不在同一个分支里牵动"删除既有 key"这件事——删除一个 key 需要同步改 15 个文件的 key 集合（`messages-completeness.test.ts` 的"key 集合完全一致"门禁），风险与改动面明显超过本单范围，留给后续清理单处理。

## 二、A3/B2/A4/B1 新增的 10 个键

范围：同样是 `src/lib/locale/messages/en.ts`，`novel` 命名空间。其它 14 个语种文件已同步补上相同的英文占位（`chapterListCount` 按各语种自己的 CLDR 复数类别集合展开分支，文案本身仍是英文占位）。

| 键 | 出现位置/语境 | 英文原文（占位） | 长度/字符限制 |
|---|---|---|---|
| `novel.chapterListTitle` | 章节列表区块标题（小说页 + 章节页，替代旧的 `novel.previewChapters`） | `Chapter list` | 区块标题，≤20 字符；不得使用"完整目录/全部章节"等宣称完整性的措辞 |
| `novel.chapterListCount` | 章节列表标题下方的数量说明（替代旧的 `novel.previewChaptersDescription`），ICU plural，参数 `{count}` = `totalChapterCount` | `{count, plural, one {1 chapter total} other {{count} chapters total}}` | 单行说明；每个语种必须覆盖自己的 CLDR 复数类别集合（`tests/ui/messages-completeness.test.ts` 的 `EXPECTED_PLURAL_CATEGORIES` 表），不多不少 |
| `novel.lockedChapterHint` | 锁定章节按钮的读屏专用提示（视觉上只有锁图标 + 章节号，`sr-only`） | `Locked — tap to continue reading` | 读屏文本，不限长度但建议简短（≤50 字符） |
| `novel.expandAllChapters` | "展开全部 N 章"按钮，参数 `{count}` = 锁定条目总数 | `Show all {count} chapters` | 按钮标签，含插值，≤40 字符（不含插值） |
| `novel.readMoreChapters` | 章节列表末尾"阅读更多章节"按钮，跳 `readOnUpstreamHref` | `Read more chapters` | 按钮标签，≤25 字符 |
| `novel.continueReadingModalTitle` | 点击锁定章节弹出的确认弹窗标题 | `Continue reading` | 弹窗标题，≤25 字符 |
| `novel.continueReadingModalBody` | 弹窗正文，参数 `{number}` = 点击的锁定章节号 | `Chapter {number} and the rest of the book are available here.` | 弹窗正文单句，含插值，≤80 字符（不含插值） |
| `novel.closeDialog` | 弹窗关闭按钮（通用） | `Close` | 按钮标签，≤15 字符 |
| `novel.newReleases` | "新书推荐"模块标题（"相关推荐"复用既有的 `novel.relatedWorks`，不是新键） | `New releases` | 区块标题，≤20 字符 |
| `novel.continueReadingBarLabel` | 固定底部浮窗（StickyCTA）的 `aria-label`，读屏 landmark 名称 | `Continue reading bar` | 读屏专用，不可见，不限长度 |

## 三、只读列出：article_template / SEO 模板里含 preview / this site / original 字样的行

按交接文档要求，**本单不改动**以下内容，只读方式列出，供运营在后台自行修改（`ArticleTemplate` 管理界面/后续模板 CRUD 上线后）：

| 文件 | 行 | 内容 | 说明 |
|---|---|---|---|
| `src/server/content-creation/default-article-template.ts` | 81（`DEFAULT_ARTICLE_TEMPLATE.body` 数组第 6 项） | `"{if preview_chapter_count}<p>Free preview chapters available: {preview_chapter_count}</p>{endif}",` | 内置默认文章模板（`ArticleTemplate` 表目前零行，这是代码常量兜底）。渲染进 `Article.body`，经 A2/D2 本轮改动后**不再被小说页可视渲染**，但仍用于 FAQ JSON-LD 抽取与 SEO 元数据来源；含"preview"字样 |

全量检查范围：`src/lib/seo/`（含 `seo-templates/*.ts`、`template/*.ts`）、`src/server/content-creation/`、`prisma/schema.prisma`、`prisma/migrations/`（只读 grep，未连生产库，只看仓库内文件与种子）。除上表一条外，其余命中全部是表名/列名/枚举值（如 `status="preview"`、`novel_preview_policy` 表名），不是面向用户的文案，不登记。

页脚免责声明（`SiteSetting.footer_disclaimer_text`，后台可编辑独立字段）本单不动，其内容由运营自行决定，不在本清单范围。

## 四、翻译单交接说明

- 第一部分（17 个既有键）：只改英文值已改，**14 个语种的旧译文原样保留**，需要翻译单根据"新英文原文"重新翻译对应键。
- 第二部分（10 个新键）：14 个语种目前是英文占位，需要翻译单补全真正的译文；`chapterListCount` 的翻译需要按该语种自己的 CLDR 复数类别（见 `tests/ui/messages-completeness.test.ts` 的 `EXPECTED_PLURAL_CATEGORIES` 表）逐类别给出译文，不能只给一个 `other` 分支（除非该语种本来就只有 `other` 类别）。
- 翻译落地后：从 `tests/ui/messages-completeness.test.ts` 的 `ALLOW_SAME_AS_EN` 移除本单登记的 10 个新键（17 个既有键从未加入这个白名单，不需要处理）。
