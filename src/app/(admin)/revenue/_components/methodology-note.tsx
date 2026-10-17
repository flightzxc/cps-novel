/**
 * 口径说明条：常驻在页面顶部，不可折叠。
 *
 * 这条文字是整页数字的"出厂说明"——运营看到的每一个数都只在这个口径下成立，
 * 所以它不跟筛选、不跟权限细节走，只要页面渲染出数据就一定在。
 *
 * 账号级：上游收益接口不区分应用，数字是该畅读账号下**全部网文应用**的合计。`novelAppCount` 是
 * 读服务给出的、该账号所在 channel 下 active 的网文应用数；没有可用 / 唯一账号时为 `null`，
 * 此时不写“当前 N 个应用”（不编一个数字）。
 *
 * v0.6.2：按书（上游维度 8，书与本站来源条目按 seriesId 匹配）与国家分布（逐日下钻，新用户 + 激活）已接入，
 * 口径说明补一句来源；推广码 / 口令维度仍然不拆（口令码不得落库）。
 */
export function revenueMethodologyText(novelAppCount: number | null): string {
  const head = novelAppCount === null
    ? "账号级 · 该畅读账号下全部网文应用合计 · "
    : `账号级 · 该畅读账号下全部网文应用合计（当前 ${novelAppCount} 个应用）· `;
  return (
    `${head}仅网文（projectType=1）· 达人凭证 · 北京时间日期。`
    + "上游次日可查，近几天会被上游回补，建议每次同步至少覆盖最近 7 天。"
    + "按书数据来自上游按书维度（书与本站按 seriesId 匹配，匹配不上标“未匹配”）；"
    + "国家分布来自逐日下钻：有激活的日期查激活、有新用户的日期查新用户（每天最多 2 次请求）；"
    + "激活不可跨日相加，排行里给日均。不统计按国家的收入，不按推广码 / 口令拆分。"
  );
}

export function MethodologyNote({ novelAppCount }: { novelAppCount: number | null }) {
  return (
    <section
      aria-label="口径说明"
      data-testid="revenue-methodology-note"
      className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900"
    >
      <p>{revenueMethodologyText(novelAppCount)}</p>
    </section>
  );
}
