"use client";

/**
 * Error boundary for the content-management segment.
 *
 * Exists so that re-throwing is a real option. Without it, "do not swallow the
 * error" would mean handing the operator a blank screen, which is why
 * `.catch(() => null)` looked reasonable in the first place.
 *
 * Nothing from `error.message` is rendered. Next strips it in production and
 * leaves only `digest`, so any message shown here would be text that appears in
 * development and vanishes in production — and in development it could carry
 * driver detail or a connection string. The digest is shown instead: it is the
 * handle that ties this screen to the server log line.
 */
export default function NovelsError({
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
        data-testid="novels-segment-error"
        className="rounded-xl border border-red-200 bg-red-50 px-6 py-8"
      >
        <h2 className="text-sm font-semibold text-red-900">内容数据读取失败</h2>
        <p className="mt-2 text-sm text-red-800">
          这不是「没有这本书」，而是本次查询没能完成。请重试；若持续失败，请带下方编号联系后端排查。
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
