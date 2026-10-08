/**
 * B-33：静态站点地图 releases/ 的版本保留策略。
 *
 * 全部用临时目录模拟 `<root>/releases/<uuid>/` + `<root>/current`（相对软链），不连数据库。
 * 期望值一律写死数字（10、15、11……），不引用被测常量——否则把常量改成 0 时期望值会跟着变，用例就测不出来。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireSitemapGenerationLock,
  refreshStaticSitemap,
  SITEMAP_LOCK_FILE,
} from "@/lib/seo/sitemap-refresh-state";
import {
  cleanupStaticSitemapReleases,
  SITEMAP_RELEASE_CLEANUP_EVENT,
  SITEMAP_RELEASE_KEEP_RECENT,
  SITEMAP_RELEASE_MAX_CONSECUTIVE_FAILURES,
  SITEMAP_RELEASE_MAX_REMOVALS_PER_RUN,
  SITEMAP_RELEASE_ORPHAN_MIN_AGE_MS,
  SITEMAP_RELEASE_TIME_BUDGET_MS,
  type SitemapReleaseCleanupEvent,
} from "@/lib/seo/static-sitemap-retention";
import { generateStaticSitemaps } from "@/lib/seo/static-sitemap-generator";
import type { BuildSitemapFamily } from "@/lib/seo/sitemap";
import { SITEMAP_FILE_LOCK_STALE_MS } from "../../../worker/handlers/sitemap-refresh";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sitemap-retention-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "releases"), { recursive: true });
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.SITE_URL;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** 与生产同形的版本目录名：worker 路径下是任务 UUID。 */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const FILE_BYTES = { index: 40, manifest: 256, childA: 1000, childB: 2000 };
const RELEASE_BYTES = FILE_BYTES.index + FILE_BYTES.manifest + FILE_BYTES.childA + FILE_BYTES.childB;

interface FixtureRelease {
  /** 已 promote 的时间；null = manifest 里 promotedAt 为空（校验通过但 promote 前失败）；"none" = 没有 manifest。 */
  promotedAt: number | null | "none";
  /** 目录最后一次写入的时间；默认等于 promotedAt。 */
  activityAt?: number;
}

async function makeRelease(root: string, name: string, spec: FixtureRelease): Promise<void> {
  const dir = path.join(root, "releases", name);
  await fs.mkdir(path.join(dir, "sitemap"), { recursive: true });
  await fs.writeFile(path.join(dir, "sitemap.xml"), "x".repeat(FILE_BYTES.index));
  await fs.writeFile(path.join(dir, "sitemap", "a.xml"), "a".repeat(FILE_BYTES.childA));
  await fs.writeFile(path.join(dir, "sitemap", "b.xml"), "b".repeat(FILE_BYTES.childB));
  if (spec.promotedAt !== "none") {
    const manifest = JSON.stringify({
      runId: name,
      releaseName: name,
      promotedAt: spec.promotedAt === null ? null : new Date(spec.promotedAt).toISOString(),
    });
    // 补齐到固定字节数，方便断言 freedBytes。
    await fs.writeFile(path.join(dir, "manifest.json"), manifest.padEnd(FILE_BYTES.manifest, " "));
  }
  const activityAt = spec.activityAt ?? (typeof spec.promotedAt === "number" ? spec.promotedAt : NOW);
  const when = new Date(activityAt);
  await fs.utimes(path.join(dir, "sitemap", "a.xml"), when, when);
  await fs.utimes(path.join(dir, "sitemap", "b.xml"), when, when);
  if (spec.promotedAt !== "none") await fs.utimes(path.join(dir, "manifest.json"), when, when);
  await fs.utimes(path.join(dir, "sitemap"), when, when);
  await fs.utimes(dir, when, when);
}

/** n 个已 promote 版本，序号越大越新，间隔 10 分钟，最新的比 NOW 早 10 分钟。 */
async function makePromoted(root: string, count: number, startIndex = 0): Promise<string[]> {
  const names: string[] = [];
  for (let i = startIndex; i < startIndex + count; i += 1) {
    const name = uuid(i);
    await makeRelease(root, name, { promotedAt: NOW - (startIndex + count - i) * 10 * MINUTE });
    names.push(name);
  }
  return names;
}

async function pointCurrent(root: string, name: string): Promise<void> {
  await fs.rm(path.join(root, "current"), { force: true, recursive: true });
  await fs.symlink(path.join("releases", name), path.join(root, "current"), "dir");
}

async function listReleases(root: string): Promise<string[]> {
  return (await fs.readdir(path.join(root, "releases"))).sort();
}

function collect() {
  const events: SitemapReleaseCleanupEvent[] = [];
  return { events, log: (event: SitemapReleaseCleanupEvent) => { events.push(event); } };
}

async function run(root: string, extra: Partial<Parameters<typeof cleanupStaticSitemapReleases>[0]> = {}) {
  const sink = collect();
  const event = await cleanupStaticSitemapReleases({ rootDir: root, now: () => NOW, log: sink.log, ...extra });
  expect(sink.events).toEqual([event]);
  return event;
}

describe("B-33 常量", () => {
  it("保留 10 个版本；残留保护期远大于文件锁过期时间；单次删除上限与时间预算有界", () => {
    expect(SITEMAP_RELEASE_KEEP_RECENT).toBe(10);
    expect(SITEMAP_RELEASE_ORPHAN_MIN_AGE_MS).toBe(2 * HOUR);
    expect(SITEMAP_RELEASE_ORPHAN_MIN_AGE_MS).toBeGreaterThanOrEqual(2 * SITEMAP_FILE_LOCK_STALE_MS);
    expect(SITEMAP_RELEASE_MAX_REMOVALS_PER_RUN).toBe(100);
    expect(SITEMAP_RELEASE_TIME_BUDGET_MS).toBe(10_000);
    expect(SITEMAP_RELEASE_MAX_CONSECUTIVE_FAILURES).toBe(5);
  });
});

describe("B-33 保留最近 N 个", () => {
  it("25 个版本 + current（指向最新）：只剩最近 10 个，其余 15 个被删，日志的保留/删除/字节数对得上", async () => {
    const root = await tempRoot();
    const names = await makePromoted(root, 25);
    await pointCurrent(root, names[24]!);

    const event = await run(root);

    expect(await listReleases(root)).toEqual(names.slice(15).sort());
    expect(await fs.readlink(path.join(root, "current"))).toBe(path.join("releases", names[24]!));
    expect(event).toMatchObject({
      schemaVersion: 1,
      event: SITEMAP_RELEASE_CLEANUP_EVENT,
      outcome: "ok",
      keepRecent: 10,
      current: names[24],
      total: 25,
      kept: 10,
      removed: 15,
      failed: 0,
      deferred: 0,
      freedBytes: 15 * RELEASE_BYTES,
      keptOrphans: 0,
      ignored: 0,
    });
  });

  it("current 指向较旧的版本（不在最近 10 个里）：current 照样保留，共 11 个", async () => {
    const root = await tempRoot();
    const names = await makePromoted(root, 25);
    await pointCurrent(root, names[3]!);

    const event = await run(root);

    expect(await listReleases(root)).toEqual([names[3]!, ...names.slice(15)].sort());
    expect(await fs.readlink(path.join(root, "current"))).toBe(path.join("releases", names[3]!));
    expect(event).toMatchObject({ outcome: "ok", current: names[3], kept: 11, removed: 14 });
    // current 的内容完好。
    expect((await fs.readFile(path.join(root, "current", "sitemap.xml"), "utf-8")).length).toBe(FILE_BYTES.index);
  });

  it("不足 10 个版本时什么都不删，也照样写一条日志", async () => {
    const root = await tempRoot();
    const names = await makePromoted(root, 4);
    await pointCurrent(root, names[3]!);

    const event = await run(root);

    expect(await listReleases(root)).toEqual(names.sort());
    expect(event).toMatchObject({ outcome: "ok", total: 4, kept: 4, removed: 0, freedBytes: 0 });
  });
});

describe("B-33 正在写入 / 失败残留", () => {
  async function scenario() {
    const root = await tempRoot();
    // current：6 小时前 promote 的版本，另有 12 个更早的已 promote 版本（超出保留数的部分一定会被删）。
    const old = await makePromoted(root, 12);
    const current = uuid(100);
    await makeRelease(root, current, { promotedAt: NOW - 6 * HOUR });
    await pointCurrent(root, current);
    return { root, old, current };
  }

  it("刚创建、未 promote 的目录（没 manifest、1 分钟前还在写）不删", async () => {
    const { root } = await scenario();
    const fresh = uuid(200);
    await makeRelease(root, fresh, { promotedAt: "none", activityAt: NOW - MINUTE });

    const event = await run(root);

    expect(await listReleases(root)).toContain(fresh);
    expect(event.keptOrphans).toBe(1);
  });

  it("早于 current 的残留：闲置不足 2 小时（40 分钟、119 分钟）不删；刚好 2 小时和更久的才删", async () => {
    const { root } = await scenario();
    // 把 current 换成 10 分钟前才 promote 的版本，使下面几个残留都"早于 current"，只剩闲置时间不同。
    const closeCurrent = uuid(101);
    await makeRelease(root, closeCurrent, { promotedAt: NOW - 10 * MINUTE });
    await pointCurrent(root, closeCurrent);
    const idle40 = uuid(204);
    const idle119 = uuid(205);
    const idle120 = uuid(206);
    const idle121 = uuid(207);
    await makeRelease(root, idle40, { promotedAt: "none", activityAt: NOW - 40 * MINUTE });
    await makeRelease(root, idle119, { promotedAt: "none", activityAt: NOW - 119 * MINUTE });
    await makeRelease(root, idle120, { promotedAt: "none", activityAt: NOW - 120 * MINUTE });
    await makeRelease(root, idle121, { promotedAt: "none", activityAt: NOW - 121 * MINUTE });

    const event = await run(root);

    const left = await listReleases(root);
    expect(left).toContain(idle40);
    expect(left).toContain(idle119);
    expect(left).not.toContain(idle120);
    expect(left).not.toContain(idle121);
    expect(event.keptOrphans).toBe(2);
  });

  it("闲了 3 小时但比 current 还新的残留不删（可能是 promote 之后才起的新一轮）", async () => {
    const { root } = await scenario();
    const newerThanCurrent = uuid(208);
    await makeRelease(root, newerThanCurrent, { promotedAt: "none", activityAt: NOW - 3 * HOUR });

    const event = await run(root);

    expect(await listReleases(root)).toContain(newerThanCurrent);
    expect(event.keptOrphans).toBe(1);
  });

  it("早于 current 且闲置超过 2 小时的失败残留被删：没有 manifest、manifest.promotedAt 为空、manifest 损坏三种", async () => {
    const { root } = await scenario();
    const noManifest = uuid(209);
    const nullPromoted = uuid(210);
    const corrupt = uuid(213);
    await makeRelease(root, noManifest, { promotedAt: "none", activityAt: NOW - 9 * HOUR });
    await makeRelease(root, nullPromoted, { promotedAt: null, activityAt: NOW - 9 * HOUR });
    await makeRelease(root, corrupt, { promotedAt: null, activityAt: NOW - 9 * HOUR });
    const corruptManifest = path.join(root, "releases", corrupt, "manifest.json");
    await fs.writeFile(corruptManifest, "{ not json");
    await fs.utimes(corruptManifest, new Date(NOW - 9 * HOUR), new Date(NOW - 9 * HOUR));

    const event = await run(root);

    const left = await listReleases(root);
    expect(left).not.toContain(noManifest);
    expect(left).not.toContain(nullPromoted);
    expect(left).not.toContain(corrupt);
    expect(event.keptOrphans).toBe(0);
  });

  it("protectNames 里的版本（本次 runId / 别人持有的锁里的 runId）即使又老又早于 current 也不删；锁读不出时一概不删残留", async () => {
    const { root } = await scenario();
    const locked = uuid(211);
    const other = uuid(212);
    await makeRelease(root, locked, { promotedAt: "none", activityAt: NOW - 9 * HOUR });
    await makeRelease(root, other, { promotedAt: "none", activityAt: NOW - 9 * HOUR });

    await run(root, { protectNames: [locked] });
    expect(await listReleases(root)).toContain(locked);
    expect(await listReleases(root)).not.toContain(other);

    await makeRelease(root, other, { promotedAt: "none", activityAt: NOW - 9 * HOUR });
    const event = await run(root, { orphansUnsafe: true });
    expect(await listReleases(root)).toContain(other);
    expect(event.keptOrphans).toBe(2);
  });

  it("名字不是 UUID / release- 的目录、普通文件、隐藏目录一律不碰", async () => {
    const { root } = await scenario();
    await makeRelease(root, "manual-backup", { promotedAt: NOW - 30 * HOUR });
    await makeRelease(root, ".staging", { promotedAt: "none", activityAt: NOW - 30 * HOUR });
    await fs.writeFile(path.join(root, "releases", "notes.txt"), "keep");

    const event = await run(root);

    expect(await listReleases(root)).toEqual(expect.arrayContaining(["manual-backup", ".staging", "notes.txt"]));
    expect(event.ignored).toBe(3);
  });
});

describe("B-33 fail-closed", () => {
  it("current 不是软链（真实目录）/ 缺失 / 指向 releases 之外 / 指向不存在的目录：整次不删", async () => {
    const root = await tempRoot();
    await makePromoted(root, 15);
    const before = await listReleases(root);

    // 缺失
    expect(await run(root)).toMatchObject({ outcome: "skipped", reason: "current_unresolvable", removed: 0 });
    // 真实目录
    await fs.mkdir(path.join(root, "current"));
    expect(await run(root)).toMatchObject({ outcome: "skipped", reason: "current_unresolvable", removed: 0 });
    await fs.rm(path.join(root, "current"), { recursive: true });
    // 指向 releases 之外
    await fs.mkdir(path.join(root, "elsewhere"));
    await fs.symlink("elsewhere", path.join(root, "current"), "dir");
    expect(await run(root)).toMatchObject({ outcome: "skipped", reason: "current_unresolvable", removed: 0 });
    await fs.rm(path.join(root, "current"));
    // 悬空
    await fs.symlink(path.join("releases", uuid(999)), path.join(root, "current"), "dir");
    expect(await run(root)).toMatchObject({ outcome: "skipped", reason: "current_unresolvable", removed: 0 });

    expect(await listReleases(root)).toEqual(before);
  });

  it("没有 releases 目录：skipped，不抛错", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sitemap-retention-"));
    roots.push(root);
    const event = await run(root);
    expect(event).toMatchObject({ outcome: "skipped", removed: 0 });
  });
});

describe("B-33 删除失败与首次大批量", () => {
  it("删除抛错：连续 5 个失败后放弃本次，已存在的目录原样保留，日志只有错误码和目录名、没有错误消息", async () => {
    const root = await tempRoot();
    const names = await makePromoted(root, 25);
    await pointCurrent(root, names[24]!);
    const remove = vi.fn(async (directory: string) => {
      throw Object.assign(new Error(`EACCES: permission denied, rm '${directory}' TOKEN=abc`), { code: "EACCES" });
    });

    const event = await run(root, { removeDirectory: remove });

    expect(remove).toHaveBeenCalledTimes(5);
    expect(await listReleases(root)).toEqual(names.sort());
    expect(event).toMatchObject({
      outcome: "partial",
      removed: 0,
      failed: 5,
      deferred: 10,
      freedBytes: 0,
      kept: 25,
      errorCodes: ["EACCES"],
    });
    expect(event.failedReleases).toEqual(names.slice(0, 5));
    expect(JSON.stringify(event)).not.toContain("permission denied");
    expect(JSON.stringify(event)).not.toContain("TOKEN");
  });

  it("个别目录删不掉不拖累其他目录：其余照删，失败的计入 failed 并留到下次", async () => {
    const root = await tempRoot();
    const names = await makePromoted(root, 25);
    await pointCurrent(root, names[24]!);
    const remove = vi.fn(async (directory: string) => {
      if (directory.endsWith(names[2]!)) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      await fs.rm(directory, { recursive: true, force: true });
    });

    const event = await run(root, { removeDirectory: remove });

    expect(await listReleases(root)).toEqual([names[2]!, ...names.slice(15)].sort());
    expect(event).toMatchObject({ outcome: "partial", removed: 14, failed: 1, deferred: 0, errorCodes: ["EBUSY"], freedBytes: 14 * RELEASE_BYTES });
  });

  it("首次上线：300 个旧目录按每次最多 100 个、先删最旧的分批消化，最后只剩最近 10 个", async () => {
    const root = await tempRoot();
    const names = await makePromoted(root, 300);
    await pointCurrent(root, names[299]!);

    const first = await run(root);
    expect(first).toMatchObject({ outcome: "ok", total: 300, removed: 100, deferred: 190, kept: 200, freedBytes: 100 * RELEASE_BYTES });
    expect(await listReleases(root)).toEqual(names.slice(100).sort());

    const second = await run(root);
    expect(second).toMatchObject({ outcome: "ok", total: 200, removed: 100, deferred: 90, kept: 100 });
    expect(await listReleases(root)).toEqual(names.slice(200).sort());

    const third = await run(root);
    expect(third).toMatchObject({ outcome: "ok", total: 100, removed: 90, deferred: 0, kept: 10 });
    expect(await listReleases(root)).toEqual(names.slice(290).sort());

    const fourth = await run(root);
    expect(fourth).toMatchObject({ outcome: "ok", total: 10, removed: 0, deferred: 0, kept: 10 });
    expect(await fs.readlink(path.join(root, "current"))).toBe(path.join("releases", names[299]!));
  });

  it("时间预算用完就停手：不再开始新的删除，剩下的计入 deferred", async () => {
    const root = await tempRoot();
    const names = await makePromoted(root, 60);
    await pointCurrent(root, names[59]!);
    let clock = NOW;
    // 每次读钟前进 3 秒：10 秒预算只够开始很少几次删除。
    const now = () => { clock += 3_000; return clock; };

    const event = await run(root, { now });

    expect(event.removed).toBeGreaterThan(0);
    expect(event.removed).toBeLessThan(10);
    expect(event.deferred).toBe(50 - event.removed);
    expect(event.outcome).toBe("ok");
    // 先删最旧的：剩下的是最新的那一段。
    expect(await listReleases(root)).toEqual(names.slice(event.removed).sort());
  });

  it("清理中途 current 被别人切走：立刻停手，不删新的 current，outcome=partial", async () => {
    const root = await tempRoot();
    const names = await makePromoted(root, 25);
    await pointCurrent(root, names[24]!);
    let calls = 0;
    const remove = async (directory: string) => {
      calls += 1;
      await fs.rm(directory, { recursive: true, force: true });
      // 第一个目录删完后，current 被切到"本来下一个要删"的 names[1]。
      if (calls === 1) await pointCurrent(root, names[1]!);
    };

    const event = await run(root, { removeDirectory: remove });

    expect(calls).toBe(1);
    expect(await listReleases(root)).toContain(names[1]!);
    expect(await fs.readlink(path.join(root, "current"))).toBe(path.join("releases", names[1]!));
    expect(event).toMatchObject({ outcome: "partial", reason: "current_changed", removed: 1, deferred: 14 });
  });

  it("日志输出本身抛错也不外泄", async () => {
    const root = await tempRoot();
    const names = await makePromoted(root, 12);
    await pointCurrent(root, names[11]!);
    const event = await cleanupStaticSitemapReleases({
      rootDir: root,
      now: () => NOW,
      log: () => { throw new Error("sink down"); },
    });
    expect(event).toMatchObject({ outcome: "ok", removed: 2 });
  });
});

describe("B-33 接入 refreshStaticSitemap（真实生成 + 真实 promote）", () => {
  function builder(): BuildSitemapFamily {
    return async ({ type, locale }) => [{
      name: `site_${type}_${locale}.xml`,
      url: `https://fixture.example/sitemap/site_${type}_${locale}.xml`,
      lastmod: "2026-08-01T00:00:00.000Z",
      entries: [{ loc: "https://fixture.example/novel/one", lastmod: "2026-08-01T00:00:00.000Z" }],
    }];
  }

  async function refresh(
    root: string,
    runId: string,
    extra: Partial<Parameters<typeof refreshStaticSitemap>[0]> = {},
  ) {
    process.env.SITE_URL = "https://fixture.example";
    return refreshStaticSitemap({
      buildFamily: builder(),
      rootDir: root,
      runId,
      initiatedBy: "test",
      reason: "B-33",
      generate: (generation) => generateStaticSitemaps({ ...generation, types: ["mainpage"], routeLocales: ["en"] }),
      ...extra,
    });
  }

  /** 25 个早已 promote 的旧版本（一天前起每小时一个）和指向最新旧版本的 current。 */
  async function seedOld(root: string): Promise<string[]> {
    const names: string[] = [];
    const base = Date.now() - 48 * HOUR;
    for (let i = 0; i < 25; i += 1) {
      const name = uuid(i);
      await makeRelease(root, name, { promotedAt: base + i * HOUR });
      names.push(name);
    }
    await pointCurrent(root, names[24]!);
    return names;
  }

  function loggedEvents(spy: { mock: { calls: unknown[][] } }): SitemapReleaseCleanupEvent[] {
    return spy.mock.calls
      .map(([line]) => { try { return JSON.parse(String(line)); } catch { return null; } })
      .filter((value): value is SitemapReleaseCleanupEvent => value?.event === SITEMAP_RELEASE_CLEANUP_EVENT);
  }

  it("成功刷新后：current 指向新版本，旧版本只留最近 9 个 + 新版本 = 10 个，默认日志写出一条 ok", async () => {
    const root = await tempRoot();
    const old = await seedOld(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const runId = uuid(5000);

    const result = await refresh(root, runId);

    expect(result).toMatchObject({ ok: true, status: "success" });
    expect(await fs.readlink(path.join(root, "current"))).toBe(path.join("releases", runId));
    expect(await listReleases(root)).toEqual([runId, ...old.slice(16)].sort());
    const [event] = loggedEvents(log);
    expect(loggedEvents(log)).toHaveLength(1);
    expect(event).toMatchObject({ outcome: "ok", current: runId, total: 26, removed: 16, kept: 10, failed: 0 });
    expect(event!.freedBytes).toBe(16 * RELEASE_BYTES);
  });

  it("失败的刷新不清理：旧版本、current 原样，残留目录留在原地", async () => {
    const root = await tempRoot();
    const old = await seedOld(root);
    const cleanupReleases = vi.fn(async () => undefined);

    const result = await refresh(root, uuid(5001), {
      generate: async () => { throw new Error("generation failed"); },
      cleanupReleases,
    });

    expect(result.status).toBe("failed");
    expect(cleanupReleases).not.toHaveBeenCalled();
    expect(await listReleases(root)).toEqual(old.sort());
  });

  it("清理时每个目录都删不掉：刷新仍判成功，状态文件是 success，日志记了 partial 与错误码", async () => {
    const root = await tempRoot();
    const old = await seedOld(root);
    const sink = collect();
    const runId = uuid(5002);

    const result = await refresh(root, runId, {
      cleanupReleases: (options) => cleanupStaticSitemapReleases({
        ...options,
        log: sink.log,
        removeDirectory: async () => { throw Object.assign(new Error("EACCES: /app/runtime/static-sitemaps"), { code: "EACCES" }); },
      }),
    });

    expect(result).toMatchObject({ ok: true, status: "success" });
    expect(result.state.task.status).toBe("success");
    expect(await fs.readlink(path.join(root, "current"))).toBe(path.join("releases", runId));
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ outcome: "partial", removed: 0, failed: 5, errorCodes: ["EACCES"] });
    expect(await listReleases(root)).toEqual([runId, ...old].sort());
    // 文件锁已释放，下一次刷新不受影响。
    await expect(fs.lstat(path.join(root, SITEMAP_LOCK_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("清理函数整个抛错（读目录权限之类）：刷新仍判成功，warn 一条 error 日志，不带错误消息", async () => {
    const root = await tempRoot();
    await seedOld(root);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runId = uuid(5003);

    const result = await refresh(root, runId, {
      cleanupReleases: async () => { throw Object.assign(new Error("EACCES scandir /secret/path TOKEN=abc"), { code: "EACCES" }); },
    });

    expect(result).toMatchObject({ ok: true, status: "success" });
    expect(result.state.task.status).toBe("success");
    expect(await fs.readlink(path.join(root, "current"))).toBe(path.join("releases", runId));
    const events = loggedEvents(warn);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "error", reason: "cleanup_threw", errorCodes: ["EACCES"] });
    expect(JSON.stringify(events[0])).not.toContain("secret");
    expect(JSON.stringify(events[0])).not.toContain("TOKEN");
  });

  it("读目录真的失败（scandir 抛 EACCES）：清理函数自己兜住，刷新仍判成功", async () => {
    const root = await tempRoot();
    await seedOld(root);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runId = uuid(5004);
    const realReaddir = fs.readdir.bind(fs);
    // 只让清理读 releases 目录时失败（生成过程不读目录）。
    vi.spyOn(fs, "readdir").mockImplementation(((target: string, ...rest: unknown[]) => {
      if (String(target).endsWith(`${path.sep}releases`)) {
        return Promise.reject(Object.assign(new Error("EACCES: scandir"), { code: "EACCES" }));
      }
      return (realReaddir as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.readdir);

    const result = await refresh(root, runId);

    expect(result).toMatchObject({ ok: true, status: "success" });
    expect(await fs.readlink(path.join(root, "current"))).toBe(path.join("releases", runId));
    expect(loggedEvents(warn)).toEqual([expect.objectContaining({ outcome: "error", reason: "unexpected_error", errorCodes: ["EACCES"] })]);
  });

  it("本次刷新释放锁后，别人又拿走锁：锁里记的 runId 对应的目录（又老又早于 current）也不删", async () => {
    const root = await tempRoot();
    await seedOld(root);
    const other = uuid(6000);
    await makeRelease(root, other, { promotedAt: "none", activityAt: Date.now() - 30 * HOUR });
    const realRm = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation((async (target: string, options?: unknown) => {
      await realRm(target, options as Parameters<typeof fs.rm>[1]);
      // 本次刷新刚释放锁，另一次生成立刻拿到了锁。
      if (String(target).endsWith(SITEMAP_LOCK_FILE)) {
        await fs.writeFile(target, JSON.stringify({ runId: other, status: "running" }));
      }
    }) as typeof fs.rm);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await refresh(root, uuid(5005));

    expect(result.status).toBe("success");
    expect(await listReleases(root)).toContain(other);
  });

  it("锁文件在却读不出 runId：失败残留一律不删，已 promote 的超额版本照删", async () => {
    const root = await tempRoot();
    const old = await seedOld(root);
    const orphan = uuid(6001);
    await makeRelease(root, orphan, { promotedAt: "none", activityAt: Date.now() - 30 * HOUR });
    const realRm = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation((async (target: string, options?: unknown) => {
      await realRm(target, options as Parameters<typeof fs.rm>[1]);
      if (String(target).endsWith(SITEMAP_LOCK_FILE)) await fs.writeFile(target, "{ truncated");
    }) as typeof fs.rm);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await refresh(root, uuid(5006));

    expect(result.status).toBe("success");
    const left = await listReleases(root);
    expect(left).toContain(orphan);
    expect(left).not.toContain(old[0]!);
  });

  it("人工旧路径的 release-<时间>-<pid> 目录名同样被识别和保留", async () => {
    const root = await tempRoot();
    const names: string[] = [];
    for (let i = 0; i < 14; i += 1) {
      const name = `release-2026-09-${String(10 + i).padStart(2, "0")}T00-00-00-000Z-${1000 + i}-p210`;
      await makeRelease(root, name, { promotedAt: NOW - (14 - i) * HOUR });
      names.push(name);
    }
    await pointCurrent(root, names[13]!);

    const event = await run(root);

    expect(event).toMatchObject({ removed: 4, kept: 10 });
    expect(await listReleases(root)).toEqual(names.slice(4).sort());
  });

  it("acquireSitemapGenerationLock 的锁文件仍是 sitemap-generation.lock（保护逻辑读的就是这个文件）", async () => {
    const root = await tempRoot();
    expect(SITEMAP_LOCK_FILE).toBe("sitemap-generation.lock");
    const lock = await acquireSitemapGenerationLock({ rootDir: root, runId: uuid(1), initiatedBy: "test" });
    expect(lock.acquired).toBe(true);
    expect(JSON.parse(await fs.readFile(path.join(root, SITEMAP_LOCK_FILE), "utf-8")).runId).toBe(uuid(1));
  });
});
