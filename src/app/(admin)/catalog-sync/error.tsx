"use client";

/**
 * Error boundary for the `/catalog-sync` segment. Same rationale as
 * `/novels/error.tsx`: re-throwing (not `.catch(() => null)`) is the point —
 * a failed read is not "no source items", and `error.message` never renders
 * for the same reason (Next strips it in production; in development it can
 * carry driver detail this screen must not surface).
 */
export default function CatalogSyncError({
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
        data-testid="catalog-sync-segment-error"
        className="rounded-xl border border-red-200 bg-red-50 px-6 py-8"
      >
        <h2 className="text-sm font-semibold text-red-900">来源条目读取失败</h2>
        <p className="mt-2 text-sm text-red-800">
          这不是「没有来源条目」，而是本次查询没能完成。请重试；若持续失败，请带下方编号联系后端排查。
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
