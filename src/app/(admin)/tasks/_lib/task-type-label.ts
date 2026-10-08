import { REVENUE_SYNC_TASK_TYPE } from "@/lib/tasks/revenue-sync";

/**
 * 任务中心里「任务类型 -> 中文名」的登记表（v0.5.12 起）。
 *
 * 任务中心一直把 `task_type` 原样显示（列头就叫 task_type，对齐 CPS，仓库里此前没有按类型登记中文名的先例）。
 * 这里不改这个规矩：只给运营需要一眼认出来的类型补中文名，**中文名旁边仍保留原始类型字符串**
 * （告警、白名单、文档里引用的都是原始类型，不能让人对不上号）；没登记的类型一律原样显示，
 * 不替它编一句话（和 `taskFamilyLabel`、`revenue/_lib/copy.ts` 的"未知值显示原文"同一条规则）。
 *
 * key 用各类型自己的单一真源常量，不手抄字符串；`tests/backend/tasks/task-type-label.test.ts`
 * 守卫"登记的每个 key 都是 worker 里真实注册的任务类型"，防止类型改名后这里悄悄失效。
 */
export const TASK_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [REVENUE_SYNC_TASK_TYPE]: "畅读收益同步",
});

/** 已登记类型的中文名；未登记返回 null（调用方显示原始类型）。用 hasOwn：任务类型来自数据库，不能让 `constructor` 之类的原型属性命中。 */
export function taskTypeLabel(taskType: string): string | null {
  return Object.hasOwn(TASK_TYPE_LABELS, taskType) ? (TASK_TYPE_LABELS[taskType] ?? null) : null;
}

/** 标题 / 面包屑 / 子任务列表用的单行写法：「畅读收益同步（changdu.revenue_sync.v1）」；未登记类型原样返回。 */
export function taskTypeDisplay(taskType: string): string {
  const label = taskTypeLabel(taskType);
  return label === null ? taskType : `${label}（${taskType}）`;
}
