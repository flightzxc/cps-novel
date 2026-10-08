"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";

import {
  checkRangeShape,
  rangeProblemCopy,
  REVENUE_QUICK_RANGE_DAYS,
  trailingRange,
} from "../_lib/dates";

/**
 * 区间筛选：原生 `method="GET"` 表单，字段名就是 query 参数（`from` / `to`），和
 * `TaskFilters` / `NovelFilters` 同一个约定——没有 JS 也能提交，URL 就是状态。
 *
 * client 组件只做两件事：受控的日期输入（快捷项要改它们），以及提交前的区间校验
 * （反向 / 超过 92 天直接在页面上说，少一次往返）。校验不通过时 `preventDefault`；
 * 通过则放行原生提交。服务端页面仍会再校验一遍，非法区间回落默认并提示——这里只是体验层。
 *
 * 快捷项（最近 7 / 30 / 90 天）是普通链接，终点都是"北京时间今天"；`today` 由服务端给，
 * 不在浏览器里算，免得运营电脑的时区把"今天"改了。
 */
export function RangeFilter({
  dateFrom,
  dateTo,
  today,
}: {
  dateFrom: string;
  dateTo: string;
  today: string;
}) {
  const [from, setFrom] = useState(dateFrom);
  const [to, setTo] = useState(dateTo);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const check = checkRangeShape(from, to);
    if (!check.ok) {
      event.preventDefault();
      setError(rangeProblemCopy(check.problem));
      return;
    }
    setError(null);
  }

  return (
    <section
      aria-label="区间筛选"
      data-testid="revenue-range-filter"
      className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm"
    >
      <form method="GET" role="search" noValidate onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-500">开始日期</span>
          <input
            type="date"
            name="from"
            value={from}
            max={today}
            onChange={(event) => setFrom(event.target.value)}
            aria-label="开始日期"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-gray-500">结束日期</span>
          <input
            type="date"
            name="to"
            value={to}
            max={today}
            onChange={(event) => setTo(event.target.value)}
            aria-label="结束日期"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
        >
          查看
        </button>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="快捷区间">
          {REVENUE_QUICK_RANGE_DAYS.map((days) => {
            const range = trailingRange(today, days);
            const active = range.dateFrom === dateFrom && range.dateTo === dateTo;
            return (
              <Link
                key={days}
                href={`/revenue?from=${range.dateFrom}&to=${range.dateTo}`}
                aria-current={active ? "true" : undefined}
                className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "border-blue-300 bg-blue-50 text-blue-700"
                    : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                最近 {days} 天
              </Link>
            );
          })}
        </div>
      </form>
      {error && (
        <p role="alert" data-testid="revenue-range-error" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
