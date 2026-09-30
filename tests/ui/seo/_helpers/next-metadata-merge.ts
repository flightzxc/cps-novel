/**
 * 用 Next 16.1.6 自己的元数据合并函数（`next/dist/lib/metadata/resolve-metadata` 的
 * `accumulateMetadata`）合并"真实的 layout/page 元数据导出"，得到浏览器最终会看到的
 * `<title>`、og:title、twitter:title。
 *
 * 为什么不能只测各页 `buildXxxMetadata()` 的返回值（TKD 对齐 CPS，Owner 2026-09-30，
 * 施工工单第七节）：标题模板 `%s | 站点名` 挂在根布局，某个页面到底有没有被套上，取决于
 * Next 的合并规则——"模板只取自倒数第二项之前各项的合并结果"（`resolve-metadata.js`
 * 的 `i < metadataItems.length - 2`）。英文首页与根布局同层、不套，`/ja` 首页隔了一层
 * `[locale]` 布局、会套。这些只在合并时才现形，页面函数自己的返回值证明不了任何事。
 *
 * 这个助手做两件事：
 *  1. 按**磁盘上真实的 app 目录树**为一个页面收集元数据项。对应 Next 的 loader tree：根节点
 *     （根布局）、从 `src/app` 往下的**每一级路径段各一个节点**、最后一个 `__PAGE__` 节点。
 *     每个节点在 `collectMetadata` 里都会占一项——有 `layout.tsx` 就是它的元数据，**没有 layout
 *     的中间段（例如 `novel/`、`[slugParam]/`）也占一项，内容是 null**。这一点直接决定合并结果：
 *     `/`（根布局 + page，共 2 项）不套模板；`/browse`（根布局 + `browse/` 空项 + page，共 3 项）套；
 *     `/ja`（根布局 + `[locale]` 布局 + page，共 3 项）套。目录树变了，项数随之变化，测试跟着
 *     真实结构走，不是手写死的。
 *  2. 交给 Next 真正的 `accumulateMetadata` 合并（不是自己复刻规则）。
 *
 * `accumulateMetadata` 内部有 `require("server-only")`：Next 自己的打包把它别名到
 * `next/dist/compiled/server-only`，裸 Node 里解析不到。这里只在首次加载 Next 的
 * 合并模块的瞬间把这一个请求指到那个空模块，加载完立即还原，不影响其它任何解析。
 */
import { createRequire } from "node:module";

import type { Metadata } from "next";

const nodeRequire = createRequire(import.meta.url);

type ResolvedTitle = { absolute: string; template: string | null };
type ResolvedTitled = { title?: ResolvedTitle | null };
export type ResolvedMetadata = {
  title: ResolvedTitle;
  description: string | null;
  robots: unknown;
  openGraph: (ResolvedTitled & { title: ResolvedTitle; description?: string }) | null;
  twitter: (ResolvedTitled & { title: ResolvedTitle; description?: string }) | null;
} & Record<string, unknown>;

type AccumulateMetadata = (
  route: string,
  metadataItems: unknown[],
  pathname: string,
  metadataContext: Record<string, unknown>,
) => Promise<ResolvedMetadata>;

let cachedAccumulate: AccumulateMetadata | null = null;

function loadAccumulateMetadata(): AccumulateMetadata {
  if (cachedAccumulate) return cachedAccumulate;
  const Module = nodeRequire("node:module") as {
    _resolveFilename: (request: string, ...rest: unknown[]) => string;
  };
  const original = Module._resolveFilename;
  Module._resolveFilename = function patched(this: unknown, request: string, ...rest: unknown[]) {
    if (request === "server-only") return nodeRequire.resolve("next/dist/compiled/server-only/empty");
    return original.call(this, request, ...rest);
  };
  try {
    const mod = nodeRequire("next/dist/lib/metadata/resolve-metadata") as { accumulateMetadata: AccumulateMetadata };
    cachedAccumulate = mod.accumulateMetadata;
  } finally {
    Module._resolveFilename = original;
  }
  return cachedAccumulate!;
}

/** `src/app` 下所有 layout/page 模块的懒加载器（Vite 静态展开，路径含括号/方括号也照常）。 */
// 不写泛型参数：不同版本的 Next/Vite 类型对 `import.meta.glob` 是否泛型不一致（Next 16.3.3 的类型里不是），
// 用调用后的类型断言统一成需要的形状。
const APP_MODULES = import.meta.glob("/src/app/**/{layout,page}.tsx") as unknown as Record<
  string,
  () => Promise<Record<string, unknown>>
>;

type MetadataModule = {
  metadata?: Metadata;
  generateMetadata?: (props: unknown, parent: Promise<unknown>) => Metadata | Promise<Metadata>;
};

export type RouteRequest = {
  /** 页面所在目录相对 `src/app`，例如 `"[locale]/category/[slug]"`；根路由用 `""`。 */
  routeDir: string;
  /** 动态段参数，例如 `{ locale: "ja", slug: "romance" }`。 */
  params?: Record<string, string>;
  searchParams?: Record<string, string | string[]>;
  /** 请求路径，仅用于 Next 内部解析相对 URL。 */
  pathname?: string;
};

function moduleKey(dir: string, file: "layout" | "page"): string {
  return `/src/app/${dir ? `${dir}/` : ""}${file}.tsx`;
}

/**
 * 一条路由的元数据模块路径，每个路径段一项：该段目录有 `layout.tsx` 就是它的路径，没有就是 `null`
 * （Next 仍为它占一项 `[null, null]`）；第 0 项是根布局，最后一项是 `page.tsx`。
 */
export function metadataModulePaths(routeDir: string): Array<string | null> {
  const segments = routeDir === "" ? [] : routeDir.split("/");
  const paths: Array<string | null> = [];
  for (let depth = 0; depth <= segments.length; depth += 1) {
    const key = moduleKey(segments.slice(0, depth).join("/"), "layout");
    paths.push(key in APP_MODULES ? key : null);
  }
  if (paths[0] === null) throw new Error("src/app/layout.tsx (root layout) not found");
  const pageKey = moduleKey(routeDir, "page");
  if (!(pageKey in APP_MODULES)) throw new Error(`no page.tsx at src/app/${routeDir}`);
  paths.push(pageKey);
  return paths;
}

async function buildItem(path: string | null, request: RouteRequest): Promise<[unknown, null]> {
  if (path === null) return [null, null];
  const mod = (await APP_MODULES[path]!()) as MetadataModule;
  return buildItemFromModule(mod, path.endsWith("/page.tsx"), request);
}

async function buildItemFromModule(mod: MetadataModule, isPage: boolean, request: RouteRequest): Promise<[unknown, null]> {
  const props = isPage
    ? { params: Promise.resolve(request.params ?? {}), searchParams: Promise.resolve(request.searchParams ?? {}) }
    : { params: Promise.resolve(request.params ?? {}) };
  if (typeof mod.generateMetadata === "function") {
    const generate = mod.generateMetadata;
    // 与 Next 的 `getDefinedMetadata` 同形：一个 (parent) => Promise 的函数，带 $$original。
    return [Object.assign((parent: Promise<unknown>) => generate(props, parent), { $$original: generate }), null];
  }
  return [mod.metadata ?? null, null];
}

/** 合并这条路由上真实的 layout/page 元数据，返回 Next 最终解析出的元数据。 */
export async function resolveRouteMetadata(request: RouteRequest): Promise<ResolvedMetadata> {
  const accumulate = loadAccumulateMetadata();
  const paths = metadataModulePaths(request.routeDir);
  const items = await Promise.all(paths.map((path) => buildItem(path, request)));
  const pathname = request.pathname ?? "/";
  return accumulate(request.routeDir || "/", items, pathname, {
    trailingSlash: false,
    isStaticMetadataRouteFile: false,
    pathname,
  });
}

/**
 * Next 的 not-found 约定：各级路径段节点的 layout（没有则 null 项）+ 末尾的 `__PAGE__` 节点
 * （error 约定下没有 layout，null 项）+ 最后一项是 not-found 模块自己的元数据（`resolve-metadata.js`
 * 的 `errorMetadataItem`，"layout -> layout -> not-found"）。用于验证"真 404 页"的最终标题。
 */
export async function resolveNotFoundMetadata(request: { routeDir: string; notFoundModule: MetadataModule; params?: Record<string, string> }): Promise<ResolvedMetadata> {
  const accumulate = loadAccumulateMetadata();
  const segments = request.routeDir === "" ? [] : request.routeDir.split("/");
  const layoutPaths: Array<string | null> = [];
  for (let depth = 0; depth <= segments.length; depth += 1) {
    const key = moduleKey(segments.slice(0, depth).join("/"), "layout");
    layoutPaths.push(key in APP_MODULES ? key : null);
  }
  layoutPaths.push(null); // `__PAGE__` 节点：error 约定下取 layout，没有，null 项
  const routeRequest: RouteRequest = { routeDir: request.routeDir, params: request.params };
  const items = await Promise.all(layoutPaths.map((path) => buildItem(path, routeRequest)));
  // not-found 模块和其它模块一样可以导出静态 `metadata` 或 `generateMetadata`（`[locale]` 段的壳用后者）。
  items.push(await buildItemFromModule(request.notFoundModule, false, routeRequest));
  return accumulate(request.routeDir || "/", items, "/", { trailingSlash: false, isStaticMetadataRouteFile: false, pathname: "/" });
}
