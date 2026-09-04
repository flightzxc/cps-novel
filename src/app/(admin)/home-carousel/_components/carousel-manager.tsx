"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClassName } from "@/components/ui/button";
import {
  deleteManualCarouselSlotAction,
  enqueueCarouselComputeAction,
  saveCarouselConfigAction,
  saveManualCarouselSlotAction,
} from "../_actions";

type Config = { slotCount: number; newSlotCount: number; newNovelWindowDays: number; cronSchedule: string; cronTimezone: string; cronEnabled: boolean };
type Slot = { id: string; position: number; articleId: string; enabled: boolean; title: string };
type Article = { id: string; title: string };
type Candidate = { id: string; rank: number; source: string; title: string };
type ServingRow = { id: string; position: number; source: string; title: string };
type ChangeLogRow = { id: string; action: string; actorType: string; actorId: string | null; createdAt: string };

const SOURCE_LABEL: Record<string, string> = { manual: "人工位", new_novel: "新书位", recency: "最近更新" };

export function CarouselManager({
  config,
  slots,
  articles,
  latestBatch,
  candidates,
  serving,
  changeLog,
}: {
  config: Config;
  slots: readonly Slot[];
  articles: readonly Article[];
  latestBatch: { id: string; status: string; triggerSource: string; createdAt: Date; finishedAt: Date | null } | null;
  candidates: readonly Candidate[];
  serving: readonly ServingRow[];
  changeLog: readonly ChangeLogRow[];
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const positions = Array.from({ length: config.slotCount }, (_, index) => index + 1);

  async function configSubmit(data: FormData) {
    const result = await saveCarouselConfigAction({ requestId: crypto.randomUUID(), cronSchedule: String(data.get("cronSchedule") ?? ""), cronTimezone: String(data.get("cronTimezone") ?? ""), cronEnabled: data.get("cronEnabled") === "on" });
    setMessage(result.ok ? "配置已保存" : result.code);
    router.refresh();
  }
  async function slotSubmit(data: FormData) {
    const result = await saveManualCarouselSlotAction({ requestId: crypto.randomUUID(), locale: "en", position: Number(data.get("position")), articleId: String(data.get("articleId")), enabled: true });
    setMessage(result.ok ? "人工位已保存；运行计算后更新 serving" : result.code);
    router.refresh();
  }
  async function deleteSlot(slot: Slot) {
    if (!window.confirm(`确认删除人工位 #${slot.position}（${slot.title}）？删除后该位置在下次计算时回落到自动候选。`)) return;
    const result = await deleteManualCarouselSlotAction({ requestId: crypto.randomUUID(), id: slot.id, locale: "en" });
    setMessage(result.ok ? "人工位已删除" : result.code);
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
        当前规则：{config.slotCount} 个槽位、{config.newSlotCount} 个新书位、{config.newNovelWindowDays} 天窗口、最多扫描 500 条、按 Novel 去重、无封面过滤；收入分支恒为关闭。
        slotCount/newSlotCount/newNovelWindowDays 目前只能通过 carouselConfigJson 直接改写（未在此表单开放编辑，见 port-registry 偏离登记）。
      </div>
      {message && <p role="status" className="rounded border bg-gray-50 p-3 text-sm">{message}</p>}
      <form action={configSubmit} className="grid gap-4 rounded-xl border bg-white p-5 sm:grid-cols-3">
        <label className="text-sm">Cron<input name="cronSchedule" defaultValue={config.cronSchedule} className="mt-1 w-full rounded border p-2" /></label>
        <label className="text-sm">Timezone<input name="cronTimezone" defaultValue={config.cronTimezone} className="mt-1 w-full rounded border p-2" /></label>
        <label className="flex items-center gap-2 text-sm"><input name="cronEnabled" type="checkbox" defaultChecked={config.cronEnabled} />启用 cron</label>
        <button className={buttonClassName("primary")}>保存配置</button>
        <button type="button" className={buttonClassName("secondary")} onClick={() => void enqueueCarouselComputeAction({ requestId: crypto.randomUUID(), locale: "en" }).then((result) => { setMessage(result.ok ? `${result.data.status}: ${result.data.taskId}` : result.code); router.refresh(); })}>入队重新计算</button>
      </form>
      <form action={slotSubmit} className="flex flex-wrap items-end gap-3 rounded-xl border bg-white p-5">
        <label className="text-sm">位置<select name="position" className="mt-1 block rounded border p-2">{positions.map((n) => <option key={n}>{n}</option>)}</select></label>
        <label className="min-w-64 text-sm">已发布文章<select name="articleId" required className="mt-1 block w-full rounded border p-2">{articles.map((article) => <option key={article.id} value={article.id}>{article.title}</option>)}</select></label>
        <button className={buttonClassName("primary")}>添加人工位</button>
      </form>
      <div className="rounded-xl border bg-white p-5">
        <h2 className="mb-3 font-semibold">人工位</h2>
        {slots.length ? (
          <ol className="space-y-2">
            {slots.map((slot) => (
              <li key={slot.id} className="flex justify-between border-b py-2 text-sm">
                <span>{slot.position}. {slot.title}</span>
                <span className="flex gap-2">
                  <button className={buttonClassName("secondary", "px-2 py-1 text-xs")} onClick={() => void saveManualCarouselSlotAction({ requestId: crypto.randomUUID(), id: slot.id, locale: "en", position: slot.position, articleId: slot.articleId, enabled: !slot.enabled }).then(() => router.refresh())}>{slot.enabled ? "停用" : "启用"}</button>
                  <button className={buttonClassName("secondary", "px-2 py-1 text-xs")} onClick={() => void deleteSlot(slot)}>删除</button>
                </span>
              </li>
            ))}
          </ol>
        ) : <p className="text-sm text-gray-500">暂无人工位</p>}
      </div>
      <div className="rounded-xl border bg-white p-5">
        <h2 className="mb-3 font-semibold">最新批候选</h2>
        {latestBatch ? <p className="mb-2 text-xs text-gray-500">批次 {latestBatch.id.slice(0, 8)} · {latestBatch.triggerSource} · {latestBatch.status}</p> : null}
        {candidates.length ? (
          <ol className="space-y-1 text-sm">
            {candidates.map((candidate) => <li key={candidate.id}>{candidate.rank}. {candidate.title}（{SOURCE_LABEL[candidate.source] ?? candidate.source}）</li>)}
          </ol>
        ) : <p className="text-sm text-gray-500">暂无候选，尚未运行过计算</p>}
      </div>
      <div className="rounded-xl border bg-white p-5">
        <h2 className="mb-3 font-semibold">Serving 预览</h2>
        {serving.length ? (
          <ol className="space-y-1 text-sm">
            {serving.map((row) => <li key={row.id}>{row.position}. {row.title}（{SOURCE_LABEL[row.source] ?? row.source}）</li>)}
          </ol>
        ) : <p className="text-sm text-gray-500">当前无 serving 快照，前台将回落到最近更新</p>}
      </div>
      <div className="rounded-xl border bg-white p-5">
        <h2 className="mb-3 font-semibold">Change Log（最近 50 条，只读）</h2>
        {changeLog.length ? (
          <ol className="space-y-1 text-xs text-gray-600">
            {changeLog.map((row) => <li key={row.id}>{row.createdAt} · {row.action} · {row.actorType}{row.actorId ? `(${row.actorId})` : ""}</li>)}
          </ol>
        ) : <p className="text-sm text-gray-500">暂无记录</p>}
      </div>
    </div>
  );
}
