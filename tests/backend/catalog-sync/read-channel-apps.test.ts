import { describe, expect, it, vi } from "vitest";

/**
 * `readActiveChannelScanOptions` (`src/app/(admin)/catalog-sync/_lib/
 * read-channel-apps.ts`) used to require `channelAccounts: { some: {
 * status: "active", deletedAt: null } } }` in its top-level `Channel`
 * WHERE — a channel that is registered (active, with an active
 * `ChannelApp`) but has zero `ChannelAccount` rows would vanish from the
 * result entirely, looking identical to "channel doesn't exist" on
 * `/catalog-sync`. That WHERE clause was removed; the nested `select` for
 * `channelAccounts` keeps its own `status: "active", deletedAt: null`
 * filter (an empty array there is now the *signal*, not a reason to hide
 * the row), and a new explicit `hasActiveChannelAccounts` boolean carries
 * that signal instead of leaving the consumer to infer it from array
 * length.
 *
 * Same minimal hand-rolled Prisma-mock pattern as
 * `tests/backend/catalog-sync/read-source-items-eligibility.test.ts` — this
 * read has no existing test harness anywhere in the codebase.
 */

const prismaMock = vi.hoisted(() => ({
  channel: {
    findMany: vi.fn(),
  },
}));

vi.mock("@/app/api/admin/_lib/deps", () => ({ prisma: prismaMock }));

const { readActiveChannelScanOptions } = await import(
  "@/app/(admin)/catalog-sync/_lib/read-channel-apps"
);

function channelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "channel-1",
    code: "changdu",
    name: "Changdu",
    channelAccounts: [],
    channelApps: [
      {
        id: "app-1",
        sourceApp: { code: "moboreader", name: "MoboReader" },
      },
    ],
    ...overrides,
  };
}

describe("readActiveChannelScanOptions · 零渠道账号仍可见 (visible-but-disabled)", () => {
  it("渠道已注册（active + 有 active ChannelApp）但零渠道账号 → 仍返回该渠道，hasActiveChannelAccounts=false，channelAccounts=[]", async () => {
    prismaMock.channel.findMany.mockResolvedValue([channelRow({ channelAccounts: [] })]);

    const options = await readActiveChannelScanOptions();

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      id: "channel-1",
      hasActiveChannelAccounts: false,
      channelAccounts: [],
    });
    // Regression guard: the WHERE clause must never again require
    // `channelAccounts` to exist — that is exactly the bug this test
    // documents. Only `status` and `channelApps` gate the query now.
    const where = prismaMock.channel.findMany.mock.calls[0]![0].where;
    expect(where).toEqual({
      status: "active",
      channelApps: { some: { status: "active" } },
    });
  });

  it("渠道有一个或多个启用中的渠道账号 → hasActiveChannelAccounts=true，channelAccounts 原样返回", async () => {
    prismaMock.channel.findMany.mockResolvedValue([
      channelRow({
        channelAccounts: [
          { id: "acct-1", businessId: "biz-1", accountName: "主账户" },
        ],
      }),
    ]);

    const options = await readActiveChannelScanOptions();

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      hasActiveChannelAccounts: true,
    });
    expect(options[0]!.channelAccounts).toEqual([
      { id: "acct-1", businessId: "biz-1", accountName: "主账户" },
    ]);
  });

  it("nested select 仍然只挑 active + 未删除的渠道账号（这一层过滤保持不变）", async () => {
    prismaMock.channel.findMany.mockResolvedValue([channelRow()]);

    await readActiveChannelScanOptions();

    const select = prismaMock.channel.findMany.mock.calls[0]![0].select;
    expect(select.channelAccounts.where).toEqual({ status: "active", deletedAt: null });
  });
});
