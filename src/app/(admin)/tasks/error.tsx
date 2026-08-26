"use client";

/**
 * Error boundary for the `/tasks` segment. Same contract as
 * `tags/error.tsx` / `novels/error.tsx`: nothing from `error.message` is
 * rendered, only `digest` — the message could carry driver detail in
 * development and is stripped to nothing in production either way.
 */
export default function TasksError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="px-6 py-6">
      <div
        role="alert"
        data-testid="tasks-segment-error"
        className="rounded-xl border border-red-200 bg-red-50 px-6 py-8"
      >
        <h2 className="text-sm font-semibold text-red-900">任务中心数据读取失败</h2>
        <p className="mt-2 text-sm text-red-800">
          这不是「没有任务」，而是本次查询没能完成——可能是筛选/详情链接里的参数已经失效（例如任务已被清理）。
          请重试；若持续失败，请带下方编号联系后端排查。
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-xs text-red-700">错误编号 {error.digest}</p>
        )}
        <button
          type="button"
          onClick={reset}
          className="mt-4 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-800 hover:bg-red-100"
        >
          重试
        </button>
      </div>
    </div>
  );
}
