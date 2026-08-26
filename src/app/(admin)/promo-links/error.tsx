"use client";

/**
 * Error boundary for the `/promo-links` segment. Same contract as
 * `tags/error.tsx`: only `digest` is ever rendered from the error.
 */
export default function PromoLinksError({
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
        data-testid="promo-links-segment-error"
        className="rounded-xl border border-red-200 bg-red-50 px-6 py-8"
      >
        <h2 className="text-sm font-semibold text-red-900">推广链接数据读取失败</h2>
        <p className="mt-2 text-sm text-red-800">
          这不是「没有记录」，而是本次查询没能完成——常见原因是 novelId 筛选不是合法的 UUID。
          请检查筛选条件后重试；若持续失败，请带下方编号联系后端排查。
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
