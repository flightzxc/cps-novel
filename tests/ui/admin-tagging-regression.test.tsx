import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ADMIN_IMPLEMENTED_PAGES, ADMIN_NAV_ITEMS } from "@/features/admin-ui/nav-items";

/**
 * P2-06.5 Admin V1 UI — 越界回归护栏。
 *
 * 这一轮的三个页面（Canonical Tag / 来源映射 / 小说标签）各自有自己的行为测试；
 * 这个文件只测**没有做什么**。理由是每条禁令都跨越了包边界：
 * 单个页面的测试可以证明自己没越界，却证明不了整棵树没越界，而越界恰恰是
 * 「顺手多加一个按钮」最容易发生的地方。
 *
 * 每条断言对应本轮方案「不做清单」里的一项冻结约束：
 *   C1_PARAMETER_STATUS=FROZEN   → classifier 参数不得有写控件
 *   AUTO_WRITE_AUTHORIZED=NO     → 不得有 auto backfill / auto write 入口
 *   task lifecycle 继续 CLI-only → 不得有 Task Admin UI
 *   taxonomy 权威播种           → 不得有 CanonicalTag 新建/删除入口
 *   keyword 由冻结 classifier 管 → 不得有 replace_keywords 写路径
 */

const ADMIN_ROOT = "src/app/(admin)";

/** 本轮新增/改动的标签相关 UI，禁令主要针对它们，但扫描覆盖整个 admin 树。 */
const TAGGING_UI_HINTS = ["tags/canonical", "tags/mappings", "novel-tags"] as const;

function stripComments(source: string): string {
  // 与 admin-secret-boundary 同一套处理：注释里解释「为什么没有这个东西」
  // 是有价值的文档，扫描它会逼作者删掉解释。
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

async function sources(root: string): Promise<{ file: string; source: string }[]> {
  const directory = path.resolve(process.cwd(), root);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return sources(path.relative(process.cwd(), target));
      return entry.isFile() && /\.tsx?$/.test(entry.name)
        ? [
            {
              file: path.relative(process.cwd(), target),
              source: stripComments(await readFile(target, "utf8")),
            },
          ]
        : [];
    }),
  );
  return nested.flat();
}

async function adminSources() {
  const files = await sources(ADMIN_ROOT);
  expect(files.length).toBeGreaterThan(0);
  return files;
}

describe("P2-06.5 Admin V1 UI 不越界", () => {
  it("本轮的标签 UI 确实存在（否则下面的禁令是空断言）", async () => {
    const files = await adminSources();
    for (const hint of TAGGING_UI_HINTS) {
      expect(
        files.some(({ file }) => file.includes(hint)),
        `期望本轮已建 ${hint} 相关 UI；缺失会让后续禁令变成空转`,
      ).toBe(true);
    }
  });

  it("不提供 classifier 参数的写控件", async () => {
    const files = await adminSources();
    // 四个冻结参数只允许作为只读展示出现。出现在受控输入的 name/value 绑定上，
    // 就意味着有人把权威公示面板改成了 settings panel。
    const FROZEN_PARAMS = ["titleWeight", "descriptionWeight", "threshold", "maxTextTags"];
    for (const { file, source } of files) {
      for (const param of FROZEN_PARAMS) {
        const written = new RegExp(
          `(<input[^>]*\\b(?:name|id)=["']${param}["']|name=["']${param}["']|setState?\\w*\\(\\s*\\{[^}]*\\b${param}\\b)`,
          "i",
        );
        expect(source, `${file} 不得提供 ${param} 的写控件（C1 参数已冻结）`).not.toMatch(written);
      }
    }
  });

  it("不发起 replace_keywords 写请求", async () => {
    const files = await adminSources();
    for (const { file, source } of files) {
      expect(source, `${file} 不得写 keyword（keyword 由冻结的 classifier 授权管理）`).not.toContain(
        "replace_keywords",
      );
    }
  });

  it("不提供 CanonicalTag 的新建或删除入口", async () => {
    const files = (await adminSources()).filter(({ file }) => file.includes("tags/canonical"));
    expect(files.length).toBeGreaterThan(0);
    // API 只有 set_status / replace_translations / replace_aliases 三个写动作，
    // 没有 create、没有 delete。UI 出现这类入口就是在承诺一个不存在的能力。
    for (const { file, source } of files) {
      expect(source, `${file} 不得出现新建入口`).not.toMatch(/新增\s*Canonical|新建\s*Canonical|创建\s*Canonical/);
      expect(source, `${file} 不得出现删除入口`).not.toMatch(/删除标签|删除\s*Canonical/);
    }
  });

  it("不提供 auto backfill / auto write 入口", async () => {
    const files = await adminSources();
    // AUTO_WRITE_AUTHORIZED=NO。手工 manual 操作不受此限，但自动写必须无入口。
    for (const { file, source } of files) {
      expect(source, `${file} 不得触发 auto backfill`).not.toMatch(/backfill/i);
      expect(source, `${file} 不得引用 auto-write 授权闸`).not.toMatch(/AUTO_WRITE_AUTHORIZED/);
    }
  });

  it("不把 tagging backfill 暴露进既有 Task Admin UI", async () => {
    const files = await adminSources();
    for (const { file, source } of files.filter((entry) => entry.file.includes(`${ADMIN_ROOT}/tasks`))) {
      expect(source, `${file}：AUTO_WRITE_AUTHORIZED=NO`).not.toMatch(/novel_tag_backfill|tagging-backfill/i);
    }
    expect(ADMIN_IMPLEMENTED_PAGES).toContain("/tasks");
    expect(ADMIN_NAV_ITEMS.map((item) => item.href)).toContain("/tasks");
  });

  it("不新增公开的 Tag 路由", async () => {
    // 本轮只动后台。公开站点不得因此长出 /tags 之类的可索引路由。
    const publicRoots = ["src/app/[locale]", "src/app/(public)"];
    for (const root of publicRoots) {
      const files = await sources(root).catch(() => []);
      for (const { file } of files) {
        expect(
          /(^|\/)tags?(\/|$)/.test(path.dirname(file)),
          `${file}：本轮不得新增公开 Tag 路由`,
        ).toBe(false);
      }
    }
  });

  it("后台不引用公开站组件", async () => {
    const files = await adminSources();
    // 公开站 primitives 吃 --novel-* 暗色 token，混进亮色后台既错配色也错所有权。
    for (const { file, source } of files) {
      expect(source, `${file} 不得 import public-ui`).not.toMatch(
        /from\s+["']@\/features\/public-ui/,
      );
    }
  });

  it("侧栏菜单未被本轮改动", async () => {
    // 三个新页面走 /tags 子路由 + 页内 tab，不占顶级菜单位。
    expect(ADMIN_NAV_ITEMS.map((item) => item.href)).toEqual([
      "/dashboard",
      "/novels",
      "/catalog-sync",
      "/promo-links",
      "/previews",
      "/home-carousel",
      "/templates",
      "/articles",
      "/categories",
      "/tags",
      "/tasks",
      "/revenue",
      "/settings",
      "/channel-accounts",
    ]);
    expect(ADMIN_IMPLEMENTED_PAGES).toEqual([
      "/channel-accounts",
      "/novels",
      "/catalog-sync",
      "/templates",
      "/articles",
      "/home-carousel",
      "/categories",
      "/tags",
      "/tasks",
      "/promo-links",
      "/settings",
      "/settings/security",
    ]);
  });
});
