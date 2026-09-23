import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

/**
 * 领推广链接生命周期正式修复第 2 阶段第 3 步：`scheduler/index.ts` 的
 * `main()` 每轮都要调用 `runPromoClaimReleaseTick`
 * （`src/lib/tasks/promo-claim-release.ts`），而且它的失败不能阻塞既有的
 * 首页轮播入队逻辑，也不能让整个 scheduler 进程崩溃退出——`scripts/
 * run-scheduler-loop.sh` 只在子进程"跑完/崩溃"之间轮询，一次未捕获的
 * `throw` 会让这一整轮 tick 直接以非零码退出，60 秒后才重新起一个新进程,
 * 期间任何原本该发生的放行/暂停都不会发生。
 *
 * 同 `tests/backend/home-carousel/scheduler-wiring.test.ts` 的两段式写法：
 * 1. 结构断言：源码文本确实调用了活体函数,不是把结果丢弃或注释掉。
 * 2. 行为断言：`main()` 真的执行到底,即使 `runPromoClaimReleaseTick`
 *    本身 reject,也不会让 `main()` 本身 reject——`home_carousel` 的入队
 *    逻辑（`runSchedulerOnce`）不受影响,已经跑过。
 *
 * `@prisma/client`、`@/lib/locale/active-locales`、`@/lib/tasks`、
 * `@/server/home-carousel` 全部 mock 掉,这个文件永远不打开真实数据库连接。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const schedulerSource = readFileSync(resolve(repoRoot, "scheduler/index.ts"), "utf8");

describe("结构断言：scheduler/index.ts 源码里领推广放行真的接了线", () => {
  it("main() 调用了 runPromoClaimReleaseTickSafely(prisma)，不是把结果丢弃", () => {
    expect(schedulerSource).toMatch(/await\s+runPromoClaimReleaseTickSafely\(prisma\)/);
  });

  it("runPromoClaimReleaseTickSafely 内部真的调用了活体 runPromoClaimReleaseTick(prisma, ...)", () => {
    expect(schedulerSource).toMatch(/await\s+runPromoClaimReleaseTick\(prisma,\s*\{\s*now:\s*new Date\(\)\s*\}\)/);
  });

  it("runPromoClaimReleaseTickSafely 把调用包在 try/catch 里，不会向上抛出", () => {
    const start = schedulerSource.indexOf("async function runPromoClaimReleaseTickSafely");
    expect(start).toBeGreaterThan(-1);
    const body = schedulerSource.slice(start, start + 600);
    expect(body).toMatch(/try\s*\{[\s\S]*catch\s*\(error\)\s*\{/);
  });
});

vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn().mockImplementation(() => ({
    $disconnect: vi.fn(async () => {}),
  })),
}));

vi.mock("@/lib/locale/active-locales", () => ({
  queryActiveLocales: vi.fn(async () => ["en"]),
}));

vi.mock("@/server/home-carousel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/home-carousel")>();
  return {
    ...actual,
    getHomeCarouselConfig: vi.fn(async () => actual.DEFAULT_HOME_CAROUSEL_CONFIG),
  };
});

describe("行为断言：runPromoClaimReleaseTick 抛错时 main() 仍然跑完（不影响既有轮播入队）", () => {
  it("runPromoClaimReleaseTick reject 时 main() 依然 resolve，且 runSchedulerOnce 已经被调用过", async () => {
    vi.resetModules();
    const runSchedulerOnce = vi.fn(async () => []);
    const runPromoClaimReleaseTick = vi.fn(async () => {
      throw new Error("promo_claim_release boom");
    });
    vi.doMock("@/lib/tasks", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/tasks")>();
      return { ...actual, runSchedulerOnce, runPromoClaimReleaseTick };
    });

    const mod = await import("../../../scheduler/index");
    await expect(mod.main()).resolves.toBeUndefined();

    expect(runSchedulerOnce).toHaveBeenCalledTimes(1);
    expect(runPromoClaimReleaseTick).toHaveBeenCalledTimes(1);
  });

  it("runPromoClaimReleaseTick 正常返回时 main() 照常 resolve", async () => {
    vi.resetModules();
    const runSchedulerOnce = vi.fn(async () => []);
    const runPromoClaimReleaseTick = vi.fn(async () => [
      { channelAccountId: "11111111-1111-4111-8111-111111111111", action: "no_eligible_shard" as const },
    ]);
    vi.doMock("@/lib/tasks", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/lib/tasks")>();
      return { ...actual, runSchedulerOnce, runPromoClaimReleaseTick };
    });

    const mod = await import("../../../scheduler/index");
    await expect(mod.main()).resolves.toBeUndefined();
    expect(runPromoClaimReleaseTick).toHaveBeenCalledTimes(1);
  });
});
