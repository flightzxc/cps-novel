/**
 * 口径说明条：常驻在页面顶部，不可折叠。
 *
 * 这条文字是整页数字的"出厂说明"——运营看到的每一个数都只在这个口径下成立，
 * 所以它不跟筛选、不跟权限细节走，只要页面渲染出数据就一定在。
 */
export const REVENUE_METHODOLOGY_TEXT =
  "账号级 · 仅网文（projectType=1）· 达人凭证 · 北京时间日期。"
  + "上游次日可查，近几天会被上游回补，建议每次同步至少覆盖最近 7 天。"
  + "暂不支持按书、按推广码拆分。";

export function MethodologyNote() {
  return (
    <section
      aria-label="口径说明"
      data-testid="revenue-methodology-note"
      className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900"
    >
      <p>{REVENUE_METHODOLOGY_TEXT}</p>
    </section>
  );
}
