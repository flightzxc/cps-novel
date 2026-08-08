import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 公开阅读链路不得被后台权限治理波及（Owner 裁决，2026-08-08）。
 *
 * P2-04 只治理后台读取权限。站点没有面向读者的登录体系，公开试读章节必须支持匿名
 * 游客直读，因此本轮引入的任何东西——Admin Session、`content:view`、`content:read`、
 * `guardContentRead`——都**只能**存在于 `src/app/(admin)` 与 `src/app/api/admin`
 * 之内。
 *
 * 这条边界靠人盯是守不住的：公开阅读 Route 还没落地（P2-03 之后才有），等它落地时
 * 顺手 import 一个 `requireContentPage` 是最自然不过的动作，而后果是给匿名读者加了
 * 一道登录墙。所以在这里先把闸放好，让越界变成一条失败用例，而不是一次上线事故。
 *
 * 公开屏幕上不出现「登录 / 注册 / 会员」文案，由 `forbidden-fields.test.tsx` 覆盖；
 * 本文件守的是**代码依赖**，两者互补。
 */

const ADMIN_ROOTS = ["src/app/(admin)", "src/app/api/admin"] as const;

/**
 * 后台权限设施。出现在公开侧即为越界。
 *
 * 随内核收编更新过一次：`content:view` / `content:read` 现在是核心
 * `AdminCapability`，授权走统一的 `guardRead` / `hasAdminCapability`，所以这里守的
 * 是内核符号本身，而不是 P2-04 曾经的私有实现——后者已删除，继续列它等于守一个不
 * 存在的东西，用例会假绿。
 */
const ADMIN_AUTH_IMPORTS = [
  "@/lib/auth/",
  "@/server/auth/",
  "@/server/credentials",
  "_lib/content-route",
  "_lib/content-page-guard",
  "_lib/page-guard",
  "_lib/route",
  "requireAdminPage",
  "requireContentPage",
  "requireAdminSession",
  "guardRead",
  "hasAdminCapability",
  "requireAdminCapability",
  "ADMIN_CAPABILITY_CONFIG",
  "content:view",
  "content:read",
] as const;

async function walk(root: string): Promise<{ file: string; source: string }[]> {
  const directory = path.resolve(process.cwd(), root);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      const relative = path.relative(process.cwd(), target);
      if (entry.isDirectory()) return walk(relative);
      return /\.tsx?$/.test(entry.name)
        ? [{ file: relative, source: await readFile(target, "utf8") }]
        : [];
    }),
  );
  return nested.flat();
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function isAdmin(file: string): boolean {
  return ADMIN_ROOTS.some((root) => file.startsWith(root));
}

const APP_FILES = await walk("src/app");
const PUBLIC_APP_FILES = APP_FILES.filter((entry) => !isAdmin(entry.file));
const PUBLIC_UI_FILES = await walk("src/features/public-ui");

describe("公开阅读链路 · 零后台权限依赖", () => {
  it("扫描范围非空，且确实覆盖到了公开侧文件", () => {
    expect(PUBLIC_APP_FILES.length).toBeGreaterThan(0);
    expect(PUBLIC_UI_FILES.length).toBeGreaterThan(0);
    // 防止 isAdmin 写错把所有文件都判成后台，导致这组用例空转变成永远绿
    expect(APP_FILES.some((entry) => isAdmin(entry.file))).toBe(true);
    expect(PUBLIC_APP_FILES.some((entry) => entry.file.includes("dev-preview"))).toBe(true);
  });

  it.each(ADMIN_AUTH_IMPORTS)("src/app 的非后台文件不引用 %s", (symbol) => {
    for (const { file, source } of PUBLIC_APP_FILES) {
      expect(stripComments(source), `${file} 越界引用了 ${symbol}`).not.toContain(symbol);
    }
  });

  it.each(ADMIN_AUTH_IMPORTS)("src/features/public-ui 不引用 %s", (symbol) => {
    for (const { file, source } of PUBLIC_UI_FILES) {
      expect(stripComments(source), `${file} 越界引用了 ${symbol}`).not.toContain(symbol);
    }
  });

  /**
   * 匿名可读是公开侧的默认，不是某个 Route 记得放行的结果。
   * 公开侧一旦出现重定向到登录、或读取 Admin Session cookie，就是加了访问门槛。
   */
  it("公开侧不读取 Admin Session cookie，也不跳转登录", () => {
    for (const { file, source } of [...PUBLIC_APP_FILES, ...PUBLIC_UI_FILES]) {
      const code = stripComments(source);
      expect(code, `${file} 读取了后台会话 cookie`).not.toMatch(/ADMIN_SESSION_COOKIE_NAME/);
      expect(code, `${file} 出现了登录跳转`).not.toMatch(/redirect\(\s*["'`]\/login/);
      expect(code, `${file} 出现了登录跳转`).not.toMatch(/["'`]\/(login|sign-in|signin)["'`]/);
    }
  });

  /**
   * 章节是否可公开，应由「该内容是否属于允许公开/试读范围」决定，而不是后台能力位。
   * 本轮 preview 授权字段只出现在后台 DTO 里；公开侧不得据 Admin 能力位判断可读性。
   */
  it("公开侧不按 Admin 能力位判断章节可读性", () => {
    for (const { file, source } of [...PUBLIC_APP_FILES, ...PUBLIC_UI_FILES]) {
      const code = stripComments(source);
      expect(code, `${file} 用 Admin 能力位判断公开可读性`).not.toMatch(
        /hasAdminCapability|requireAdminCapability|AdminCapability/,
      );
    }
  });
});
