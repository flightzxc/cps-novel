import type { BadgeTone } from "@/components/ui/status-badge";

/**
 * `/revenue` 的运营文案（前端自己持有，不读任何服务端 message）。
 *
 * 后端 code 枚举以 `src/server/revenue/enqueue.ts` 文件头为准；未知 code **显示原文**而不是编一句话，
 * 免得后端新增 code 时页面悄悄把它说成别的意思。
 */

/** pending 任务创建后超过这么久还没被 worker 认领，就在页面上亮黄色提示。 */
export const REVENUE_WORKER_CLAIM_WARN_MS = 10 * 60 * 1000;
/** 凭证到期前多少天开始标黄。 */
export const REVENUE_CREDENTIAL_WARN_DAYS = 3;

export const REVENUE_TASK_TYPE_LABEL = "changdu.revenue_sync.v1";

/**
 * 同一畅读账号下有 ≥ 2 个网文应用时，指标卡上方的灰字提示（1 个应用时不显示）。
 * 上游 `GetReport` 不带应用维度，所以这里如实说明“合计”，并指出按应用拆分的前提。
 */
export function multiAppTotalHint(novelAppCount: number): string {
  return `上游收益接口不区分应用，以下为 ${novelAppCount} 个网文应用的合计；按应用拆分需另行接入上游"授权产品"维度。`;
}

export const WORKER_CLAIM_WARNING =
  `任务排队超过 10 分钟仍未被 worker 认领。请确认生产环境主通道 WORKER_TASK_ALLOWLIST 已包含 ${REVENUE_TASK_TYPE_LABEL}。`;

export const WORKER_CLAIM_WARNING_DETAIL =
  "漏配白名单时任务会一直排队，且之后每次发起同步都会被「已有同步任务」挡住：补齐白名单后这条任务会被正常认领；"
  + "若要放弃它，需到任务中心中止该任务（需要任务管理能力位）。";

/** 日统计行的三态（读服务 `RevenueDayRow.coverage`）。 */
export const COVERAGE_LABEL = Object.freeze({
  reported: "",
  no_upstream_row: "上游无记录",
  not_synced: "未同步",
} as const);

type BatchStatus = "pending" | "running" | "completed" | "partial_failed" | "failed";

const BATCH_STATUS: Readonly<Record<BatchStatus, { label: string; tone: BadgeTone }>> = Object.freeze({
  pending: { label: "待执行", tone: "neutral" },
  running: { label: "执行中", tone: "info" },
  completed: { label: "完成", tone: "success" },
  partial_failed: { label: "部分异常", tone: "warning" },
  failed: { label: "失败", tone: "danger" },
});

/** 批次状态 → 中文 + 徽标色；未知状态显示原文，中性色。 */
export function batchStatusView(status: string): { label: string; tone: BadgeTone } {
  return BATCH_STATUS[status as BatchStatus] ?? { label: status, tone: "neutral" };
}

const RECONCILIATION: Readonly<Record<string, { label: string; tone: BadgeTone }>> = Object.freeze({
  matched: { label: "一致", tone: "success" },
  mismatched: { label: "不一致", tone: "danger" },
  not_applicable: { label: "无总计行", tone: "neutral" },
});

export function reconciliationView(status: string | null): { label: string; tone: BadgeTone } | null {
  if (status === null) return null;
  return RECONCILIATION[status] ?? { label: status, tone: "neutral" };
}

const ACTIVE_TASK_STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({
  pending: "排队中",
  processing: "执行中",
});

export function activeTaskStatusLabel(status: string): string {
  return ACTIVE_TASK_STATUS_LABEL[status] ?? status;
}

const CREDENTIAL_STATUS: Readonly<Record<string, { label: string; tone: BadgeTone }>> = Object.freeze({
  active: { label: "有效", tone: "success" },
  superseded: { label: "已作废", tone: "neutral" },
  expired: { label: "已过期", tone: "danger" },
  invalid: { label: "校验失败", tone: "danger" },
});

export function credentialStatusView(status: string): { label: string; tone: BadgeTone } {
  return CREDENTIAL_STATUS[status] ?? { label: status, tone: "neutral" };
}

const ENQUEUE_FAILURE_COPY: Readonly<Record<string, string>> = Object.freeze({
  invalid_request: "请求无效，请刷新页面后重试",
  invalid_date_range:
    "同步区间无效：开始日期不能晚于结束日期、跨度不能超过 92 天、结束日期不能晚于今天（北京时间）",
  channel_account_unavailable:
    "没有可用的海阅渠道账号（网文应用下没有启用中的账号），请先到「渠道账户」页配置",
  channel_account_ambiguous:
    "海阅渠道账号不止一个，系统不替你挑选；请先在「渠道账户」页把网文应用下启用中的账号收敛到恰好一个",
  revenue_sync_already_active: "已有同步任务在排队或执行中，请等它结束后再发起；排队过久请到任务中心查看",
  request_token_conflict: "请求标识冲突（同一标识被用于另一份不同的请求），请刷新页面后重试",
});

/** 入队失败 code → 中文原因；未知 code 显示原文。 */
export function enqueueFailureCopy(code: string): string {
  return ENQUEUE_FAILURE_COPY[code] ?? `同步未能发起（错误码：${code}）`;
}
