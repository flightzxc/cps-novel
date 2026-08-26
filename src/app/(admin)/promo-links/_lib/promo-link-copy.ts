/**
 * Human copy for `/promo-links` — status and `errorKind` vocabulary.
 *
 * Every value here is traced to `worker/handlers/promo-link-claim.ts`'s
 * write paths (the only place `PromoLink.status` / `error_kind` are ever
 * set) and to `src/lib/adapters/promo-link-claim.ts`'s
 * `PromoLinkClaimAdapterErrorCode`. Two failure branches in that handler
 * (`resolveClaimCredential` failing, `buildClaimPromoRequest` returning
 * null) carry a `protectedWrite: async () => undefined` — they report
 * `status: "failed"` back to the task-item layer but never write a
 * `PromoLink` row, so their codes (`credential_missing`,
 * `credential_expired`, `credential_invalid`, `claim_source_fields_missing`)
 * can never appear in `errorKind` here and are deliberately not listed
 * below — listing them would document a state this table cannot ever show.
 */
export const PROMO_LINK_STATUSES = ["pending", "fetched", "failed", "registered_disabled"] as const;

export type PromoLinkStatusFilter = (typeof PROMO_LINK_STATUSES)[number];

export const PROMO_LINK_STATUS_LABELS: Readonly<Record<PromoLinkStatusFilter, string>> = Object.freeze({
  pending: "待处理",
  fetched: "已获取",
  failed: "失败",
  registered_disabled: "能力已冻结",
});

export function promoLinkStatusLabel(status: string): string {
  return PROMO_LINK_STATUS_LABELS[status as PromoLinkStatusFilter] ?? status;
}

export const PROMO_LINK_ORIGIN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  upstream_existing: "沿用上游既有推广资源",
  claimed: "本次领取新建",
});

export function promoLinkOriginLabel(origin: string): string {
  return PROMO_LINK_ORIGIN_LABELS[origin] ?? origin;
}

type ErrorKindCopy = { readonly label: string; readonly explanation: string; readonly actionable: boolean };

/**
 * Keyed by the exact `errorKind` string the worker writes. `actionable:
 * true` means this row's blocker is something an operator can act on right
 * now from this screen (currently only `claim_manual_review_required`,
 * which links into `/tasks`'s manual-review section).
 */
const ERROR_KIND_COPY: Readonly<Record<string, ErrorKindCopy>> = Object.freeze({
  existing_evidence_redacted: {
    label: "本地证据被脱敏，不可用",
    explanation:
      "同步适配器已经把这一行的推广字段脱敏成占位符，本地数据无法用来判断上游是否已经有推广码。" +
      "系统不会据此发起领取，也不会伪造一个可用的结果——需要人工核实，或等待脱敏范围调整后重新同步。",
    actionable: false,
  },
  claim_manual_review_required: {
    label: "存在结果未知的领取尝试，等待人工裁决",
    explanation:
      "上一次领取尝试的结果无法确认（例如超时或响应异常），系统已经阻止自动重试，" +
      "避免在不知道是否已经领取过的情况下重复领取。需要去任务中心的人工审查区裁决后才会解除阻塞。",
    actionable: true,
  },
  capability_disabled: {
    label: "领取能力已冻结",
    explanation:
      "领取推广码（claimPromo）这个能力目前处于 registered_disabled，未经 Owner 解冻，系统不会发起任何请求。" +
      "这不是这一行数据本身的问题，也不是渠道账户的问题。",
    actionable: false,
  },
  endpoint_not_evidenced: {
    label: "领取接口契约尚未证实",
    explanation:
      "这个能力的真实请求/响应契约还没有拿到验证证据，生产实现会直接拒绝调用，不会凭猜测发出请求。",
    actionable: false,
  },
  transport_error: {
    label: "网络传输失败",
    explanation: "请求在发送阶段就失败了（网络或连接问题），属于可重试的失败。",
    actionable: false,
  },
  request_timeout: {
    label: "请求超时",
    explanation:
      "上游没有在超时时间内响应。若这次超时导致结果无法确认，实际会被归入人工审查（见上一条），" +
      "这个分类只出现在已经能确认是「超时导致失败」而非「结果不明」的场景。",
    actionable: false,
  },
  upstream_http_error: {
    label: "上游 HTTP 错误",
    explanation: "上游返回了非成功的状态码。",
    actionable: false,
  },
  malformed_payload: {
    label: "响应格式异常",
    explanation: "上游返回的内容无法按约定格式解析。",
    actionable: false,
  },
});

const NO_ERROR_PENDING: ErrorKindCopy = {
  label: "尚未发起领取尝试",
  explanation: "这一行还没有被处理过，等待任务调度。",
  actionable: false,
};

const NO_ERROR_FETCHED: ErrorKindCopy = {
  label: "已成功获取",
  explanation: "推广资源已经就绪，可以正常使用。",
  actionable: false,
};

const NO_ERROR_FALLBACK: ErrorKindCopy = {
  label: "无异常",
  explanation: "没有记录到失败原因。",
  actionable: false,
};

/**
 * `errorKind` is `null` for two very different reasons depending on
 * `status`: a `fetched` row with no error means success, a `pending` row
 * with no error means "not attempted yet" — collapsing both into one "无"
 * label would erase that difference on the one column operators scan first.
 */
export function promoLinkErrorKindCopy(status: string, errorKind: string | null): ErrorKindCopy {
  if (errorKind) {
    return (
      ERROR_KIND_COPY[errorKind] ?? {
        label: errorKind,
        explanation: "未登记的错误分类——请联系工程核实这是否是一个新出现的失败原因。",
        actionable: false,
      }
    );
  }
  if (status === "pending") return NO_ERROR_PENDING;
  if (status === "fetched") return NO_ERROR_FETCHED;
  return NO_ERROR_FALLBACK;
}

export const PROMO_LINKS_EMPTY_STATE = "没有符合当前筛选条件的推广链接记录。试试放宽状态筛选，或清空 novelId。";

export const PROMO_LINKS_LIST_LIMIT_NOTE =
  "本列表没有翻页——接口只支持一次性返回最近更新的若干条（最多 100 条），不存在第 2 页。" +
  "如果没有看到目标记录，请用状态筛选或填写具体的 novelId 缩小范围。";
