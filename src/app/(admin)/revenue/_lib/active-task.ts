import { REVENUE_WORKER_CLAIM_WARN_MS } from "./copy";

/**
 * "排队过久仍没被 worker 认领"的判定。
 *
 * 为什么要把它做成页面上看得见的信号：收益同步任务类型必须出现在**主通道**
 * `WORKER_TASK_ALLOWLIST` 里 worker 才会领取。生产漏配时任务会一直 `pending`，既没有告警，
 * 也不会被 preflight 拦住，还会因为"同一账号同时只有一个活跃任务"让之后每一次入队都被挡住——
 * 运营看到的只会是"按钮永远点不动"。所以 pending 超过阈值就必须在页面上说出来。
 *
 * 只看 `pending`：`processing` 说明已经有 worker 领走了，慢是另一回事，不在这个信号的语义里。
 * 严格大于阈值才算（恰好 10 分钟还不算）。创建时间解析不出来 → 不亮（宁可漏报，也不拿坏数据吓人）。
 */
export function isStalePendingTask(
  task: { readonly status: string; readonly createdAt: string },
  nowMs: number,
): boolean {
  if (task.status !== "pending") return false;
  const createdMs = Date.parse(task.createdAt);
  if (Number.isNaN(createdMs)) return false;
  return nowMs - createdMs > REVENUE_WORKER_CLAIM_WARN_MS;
}

/** 任务编号太长，页面上只露前 8 位，完整值放 title / 链接里。 */
export function shortTaskId(id: string): string {
  return id.slice(0, 8);
}
