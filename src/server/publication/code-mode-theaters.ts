/**
 * 口令码模式剧场的枚举（v0.6.0）。
 *
 * 首页轮播显式排除口令码模式的书（Owner 10-14 拍板第 4 项：轮播位置稀缺、看到的多是第一次来的读者，
 * 口令码模式要先下载 App 再搜口令门槛高；而且不做点击埋点，两种转化测不出来，所以先保守。以后有数据了放开
 * 只是删掉这几处排除）。排除用的是"推广链接所属剧场编号 notIn 口令码剧场编号"——查询里不写 JSON 路径过滤：
 * Prisma 的 `NOT (config #>> '{promoMode}' = 'code')` 遇到缺键（旧记录 `config = {}`）是 NULL，会把所有
 * 老 MoboReader 的书一起排除掉，这正是要避免的事故形状。
 *
 * 剧场表只有几行，每次现读一次，不缓存：剧场模式一变，下一次计算 / 渲染立刻按新模式。
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { isCodeModeTheater } from "./theater-promo-mode";

type Db = Pick<PrismaClient, "channelApp"> | Pick<Prisma.TransactionClient, "channelApp">;

/** 所有 `promoMode = "code"` 的剧场编号（不论剧场当前是否启用：停用的口令码剧场，它的书同样不进轮播）。 */
export async function loadCodeModeChannelAppIds(db: Db): Promise<string[]> {
  const apps = await db.channelApp.findMany({ select: { id: true, config: true }, orderBy: { id: "asc" } });
  return apps.filter((app) => isCodeModeTheater(app.config)).map((app) => app.id);
}

/** 追加到 Article 查询条件里的"推广链接不属于任何口令码剧场"；没有口令码剧场时是空对象（查询与改动前逐字相同）。 */
export function excludeCodeModePromoWhere(codeModeChannelAppIds: readonly string[]): Prisma.ArticleWhereInput {
  return codeModeChannelAppIds.length === 0
    ? {}
    : { promoLink: { is: { channelAppId: { notIn: [...codeModeChannelAppIds] } } } };
}
