"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buttonClassName } from "@/components/ui/button";
import type { CatalogBatchContext, CatalogSelection, PromoClaimShardEstimate } from "@/domain/catalog-batch";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

import {
  enqueuePromoLinkClaimAction,
  readCatalogBatchContextAction,
  readCatalogBatchSummaryAction,
  readPromoClaimShardEstimateAction,
} from "../_actions";

type Stage = "loading" | "form" | "submitting" | "counting" | "error";
type Group = CatalogBatchContext["channelGroups"][number] & {
  active?: boolean;
  claimCapabilityEnabled?: boolean;
};

export function PromoLinkClaimDialog({
  selection,
  promoClaimGranted,
  promoClaimBlockedReason,
  onClose,
  onSubmitted,
}: {
  selection: CatalogSelection;
  promoClaimGranted: boolean;
  promoClaimBlockedReason: string | null;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const mountedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const pollRef = useRef<(id: string) => Promise<void>>(async () => {});
  const selectionRef = useRef(selection);
  const requestIdRef = useRef(crypto.randomUUID());
  const submittedRef = useRef(false);
  const frozenAccountsRef = useRef<Record<string, string> | null>(null);
  const [context, setContext] = useState<CatalogBatchContext | null>(null);
  const [accounts, setAccounts] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<Stage>("loading");
  const [message, setMessage] = useState("");
  const [taskId, setTaskId] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ submittedCount: number | null; ineligibleCount: number | null } | null>(null);
  const [isFrozen, setIsFrozen] = useState(false);
  // 阶段2 第4步（施工任务 3.6，设计 §5.9）："预计分 N 片、预计耗时 X 小时"——
  // 只在开关开启时才有意义；开关关闭时 `context.lifecycleEnabled` 缺失
  // （按 `false` 处理），下面这条对话框的行为逐字不变（含"单账户自动提交"）。
  const [estimate, setEstimate] = useState<PromoClaimShardEstimate | null>(null);

  const groups = useMemo(
    () => (context?.channelGroups ?? []) as readonly Group[],
    [context],
  );
  const invalidGroup = useMemo(
    () => groups.find((group) => group.active === false || group.claimCapabilityEnabled === false || !group.accounts.length),
    [groups],
  );
  const needsAccountChoice = useMemo(
    () => groups.some((group) => group.accounts.length !== 1),
    [groups],
  );
  const lifecycleEnabled = context?.lifecycleEnabled === true;
  // 所有还有资格条目的渠道分组都已经选好账户——单账户分组已经被默认值
  // 填好，只有多账户分组需要运营手动选择。在这之前不请求预估（请求了也只
  // 会是"还差几个账户没选"的半成品数字，容易误导）。
  const allAccountsChosen = useMemo(
    () => groups.every((group) => group.eligibleCount === 0 || Boolean(accounts[group.channelAppId])),
    [groups, accounts],
  );

  useEffect(() => {
    mountedRef.current = true;
    dialogRef.current?.showModal();
    void readCatalogBatchContextAction({ selection: selectionRef.current, requestId: crypto.randomUUID() })
      .then((result) => {
        if (!mountedRef.current) return;
        if (!result.ok) {
          setMessage(result.kind === "access_denied" ? errorEnvelopeCopy(result.envelope) : "无法读取所选条目，请重试");
          setStage("error");
          return;
        }
        const defaults: Record<string, string> = {};
        result.data.channelGroups.forEach((group) => {
          if (group.accounts.length === 1) defaults[group.channelAppId] = group.accounts[0]!.id;
        });
        setContext(result.data);
        setAccounts(defaults);
        setStage("form");
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setMessage("无法读取所选条目，请重试");
        setStage("error");
      });
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const poll = useCallback(async (id: string): Promise<void> => {
    try {
      const result = await readCatalogBatchSummaryAction({ taskId: id, requestId: crypto.randomUUID() });
      if (!mountedRef.current) return;
      if (!result.ok) {
        setMessage("无法读取任务统计，请在任务中心查看");
        setStage("error");
        return;
      }
      if (result.data.submittedCount !== null && result.data.ineligibleCount !== null) {
        setSummary(result.data);
        return;
      }
      if (["disabled", "failed", "expired"].includes(result.data.phase)) {
        setMessage("任务已提交，请在任务中心查看状态");
        setStage("error");
        return;
      }
      timerRef.current = window.setTimeout(() => {
        if (mountedRef.current) void pollRef.current(id);
      }, 900);
    } catch {
      if (!mountedRef.current) return;
      setMessage("无法读取任务统计，请在任务中心查看");
      setStage("error");
    }
  }, []);

  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);

  const submit = useCallback(async (): Promise<void> => {
    if (!context || !promoClaimGranted || invalidGroup || taskId || submittedRef.current) return;
    if (groups.some((group) => group.eligibleCount > 0 && !accounts[group.channelAppId])) {
      setMessage("请为每个渠道选择账户");
      setStage("error");
      return;
    }
    submittedRef.current = true;
    frozenAccountsRef.current ??= { ...accounts };
    setIsFrozen(true);
    setStage("submitting");
    try {
      const result = await enqueuePromoLinkClaimAction({
        selection: selectionRef.current,
        channelAccounts: frozenAccountsRef.current,
        requestId: requestIdRef.current,
      });
      if (!mountedRef.current) return;
      if (!result.ok) {
        submittedRef.current = false;
        setMessage(result.kind === "access_denied" ? errorEnvelopeCopy(result.envelope) : "提交失败，请检查账户后重试");
        setStage("error");
        return;
      }
      setTaskId(result.data.taskId);
      onSubmitted();
      setStage("counting");
      void poll(result.data.taskId);
    } catch {
      if (!mountedRef.current) return;
      submittedRef.current = false;
      setMessage("提交失败，请重试");
      setStage("error");
    }
  }, [accounts, context, groups, invalidGroup, onSubmitted, poll, promoClaimGranted, taskId]);

  useEffect(() => {
    // 开关开启时不再自动提交——运营必须先看到"预计分 N 片、预计耗时 X 小时"
    // 再手动点击确认（下面的按钮可见性条件已经加了 `lifecycleEnabled`）。
    // 开关关闭（`lifecycleEnabled` 为 `false`）时这条判断逐字不变，单账户
    // 分组仍然自动提交一次。
    if (context && stage === "form" && !needsAccountChoice && !invalidGroup && promoClaimGranted && !lifecycleEnabled && !submittedRef.current) {
      void submit();
    }
  }, [context, invalidGroup, lifecycleEnabled, needsAccountChoice, promoClaimGranted, stage, submit]);

  useEffect(() => {
    if (!context || !lifecycleEnabled || !allAccountsChosen || stage !== "form") { setEstimate(null); return; }
    let cancelled = false;
    void readPromoClaimShardEstimateAction({
      selection: selectionRef.current, channelAccounts: accounts, requestId: crypto.randomUUID(),
    }).then((result) => {
      if (cancelled || !mountedRef.current) return;
      if (result.ok) setEstimate(result.data);
    }).catch(() => {
      // 预估失败不阻断提交——只是不显示这行文案，同 credentialWarnings 的
      // "advisory only" 纪律：预估从来不是准入判断的一部分。
    });
    return () => { cancelled = true; };
  }, [accounts, allAccountsChosen, context, lifecycleEnabled, stage]);

  const canSubmit = Boolean(context)
    && promoClaimGranted
    && !invalidGroup
    && !taskId
    && stage !== "submitting"
    && (stage === "form" || stage === "error");

  return (
    <dialog
      ref={dialogRef}
      className="m-auto max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-xl border border-gray-200 bg-white p-0 text-gray-900 shadow-xl backdrop:bg-gray-900/40"
      onCancel={(event) => {
        event.preventDefault();
        if (stage !== "submitting") onClose();
      }}
    >
      <div className="space-y-4 p-5">
        <h2 className="text-base font-semibold">领取推广链接</h2>
        {stage === "loading" && <p className="text-sm text-gray-600">正在读取所选条目…</p>}
        {invalidGroup && (
          <p role="alert" className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
            {invalidGroup.accounts.length ? "该渠道当前未启用推广领取能力" : "该渠道没有可用账户"}
          </p>
        )}
        {needsAccountChoice && groups.map((group) => (
          <label key={group.channelAppId} className="block text-sm text-gray-700">
            {group.channelName}（{group.eligibleCount} 条）
            <select
              value={accounts[group.channelAppId] ?? ""}
              disabled={isFrozen}
              onChange={(event) => {
                if (!isFrozen) {
                  setAccounts((current) => ({ ...current, [group.channelAppId]: event.target.value }));
                }
              }}
              className="mt-1 w-full rounded border border-gray-300 bg-white p-2 text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
            >
              <option value="">选择账户</option>
              {group.accounts.map((account) => (
                <option value={account.id} key={account.id}>{account.name}</option>
              ))}
            </select>
          </label>
        ))}
        {promoClaimBlockedReason && (
          <p className="rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">{promoClaimBlockedReason}</p>
        )}
        {lifecycleEnabled && !taskId && stage === "form" && (
          <p className="rounded border border-blue-200 bg-blue-50 p-2 text-sm text-blue-900" data-testid="promo-claim-shard-estimate">
            {allAccountsChosen
              ? (estimate
                ? `预计分 ${estimate.totalShardCount.toLocaleString("zh-CN")} 片，预计耗时 ${estimate.estimatedHours.toLocaleString("zh-CN")} 小时`
                : "正在估算分片数与预计耗时…")
              : "选好账户后即可估算分片数与预计耗时"}
          </p>
        )}
        {taskId && <Link href={`/tasks/${taskId}`} className="text-sm text-blue-700 underline">查看任务</Link>}
        {stage === "counting" && (
          <p role="status" className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
            {summary ? <>
              任务已提交：{(summary.submittedCount ?? 0).toLocaleString("zh-CN")} 条<br />
              不符合领取条件：{(summary.ineligibleCount ?? 0).toLocaleString("zh-CN")} 条
            </> : "任务已提交，正在统计…"}
          </p>
        )}
        {stage === "error" && (
          <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">{message}</p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClassName("secondary")} onClick={onClose} disabled={stage === "submitting"}>
            关闭
          </button>
          {!taskId && (needsAccountChoice || stage === "error" || lifecycleEnabled) && (
            <button type="button" className={buttonClassName("primary")} disabled={!canSubmit} onClick={() => void submit()}>
              领取推广链接
            </button>
          )}
        </div>
      </div>
    </dialog>
  );
}
