"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClassName } from "@/components/ui/button";
import { enqueueCarouselComputeAction, saveCarouselConfigAction, saveManualCarouselSlotAction } from "../_actions";

export function CarouselManager({ config, slots, articles }: { config: { cronSchedule: string; cronTimezone: string; cronEnabled: boolean }; slots: readonly { id: string; position: number; articleId: string; enabled: boolean; title: string }[]; articles: readonly { id: string; title: string }[] }) {
  const router = useRouter(); const [message, setMessage] = useState<string | null>(null);
  async function configSubmit(data: FormData) { const result = await saveCarouselConfigAction({ requestId: crypto.randomUUID(), cronSchedule: String(data.get("cronSchedule") ?? ""), cronTimezone: String(data.get("cronTimezone") ?? ""), cronEnabled: data.get("cronEnabled") === "on" }); setMessage(result.ok ? "配置已保存" : result.code); router.refresh(); }
  async function slotSubmit(data: FormData) { const result = await saveManualCarouselSlotAction({ requestId: crypto.randomUUID(), locale: "en", position: Number(data.get("position")), articleId: String(data.get("articleId")), enabled: true }); setMessage(result.ok ? "人工位已保存；运行计算后更新 serving" : result.code); router.refresh(); }
  return <div className="space-y-6">
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">固定规则：5 个槽位、1 个新书位、14 天窗口、最多扫描 500 条、按 Novel 去重、无封面过滤；收入分支恒为关闭。</div>
    {message && <p role="status" className="rounded border bg-gray-50 p-3 text-sm">{message}</p>}
    <form action={configSubmit} className="grid gap-4 rounded-xl border bg-white p-5 sm:grid-cols-3"><label className="text-sm">Cron<input name="cronSchedule" defaultValue={config.cronSchedule} className="mt-1 w-full rounded border p-2" /></label><label className="text-sm">Timezone<input name="cronTimezone" defaultValue={config.cronTimezone} className="mt-1 w-full rounded border p-2" /></label><label className="flex items-center gap-2 text-sm"><input name="cronEnabled" type="checkbox" defaultChecked={config.cronEnabled} />启用 cron</label><button className={buttonClassName("primary")}>保存配置</button><button type="button" className={buttonClassName("secondary")} onClick={() => void enqueueCarouselComputeAction({ requestId: crypto.randomUUID(), locale: "en" }).then((result) => { setMessage(result.ok ? `${result.data.status}: ${result.data.taskId}` : result.code); router.refresh(); })}>入队重新计算</button></form>
    <form action={slotSubmit} className="flex flex-wrap items-end gap-3 rounded-xl border bg-white p-5"><label className="text-sm">位置<select name="position" className="mt-1 block rounded border p-2">{[1,2,3,4,5].map((n) => <option key={n}>{n}</option>)}</select></label><label className="min-w-64 text-sm">已发布文章<select name="articleId" required className="mt-1 block w-full rounded border p-2">{articles.map((article) => <option key={article.id} value={article.id}>{article.title}</option>)}</select></label><button className={buttonClassName("primary")}>添加人工位</button></form>
    <div className="rounded-xl border bg-white p-5"><h2 className="mb-3 font-semibold">人工位</h2>{slots.length ? <ol className="space-y-2">{slots.map((slot) => <li key={slot.id} className="flex justify-between border-b py-2 text-sm"><span>{slot.position}. {slot.title}</span><button className={buttonClassName("secondary", "px-2 py-1 text-xs")} onClick={() => void saveManualCarouselSlotAction({ requestId: crypto.randomUUID(), id: slot.id, locale: "en", position: slot.position, articleId: slot.articleId, enabled: !slot.enabled }).then(() => router.refresh())}>{slot.enabled ? "停用" : "启用"}</button></li>)}</ol> : <p className="text-sm text-gray-500">暂无人工位</p>}</div>
  </div>;
}
