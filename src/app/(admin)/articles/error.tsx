"use client";

/**
 * Error boundary for the `/articles` segment.
 *
 * M7 gave this page its own query-string-driven filters and real pagination
 * (`listArticles`), which is a new way for it to throw. Bad-filter cases
 * (`AdminContentQueryError`) are caught inline by `page.tsx` and rendered as
 * a `ContentErrorPanel` — this boundary only catches everything else, same
 * split as `../novels/error.tsx` (outside this lane's file boundary, mirrored
 * here rather than imported so `/articles` does not depend on the novels
 * segment for its own error UI).
 *
 * Nothing from `error.message` is rendered, for the same reason as
 * `../novels/error.tsx`: Next strips it in production and leaves only
 * `digest`, and in development it could carry driver detail or a connection
 * string.
 */
export default function ArticlesError({
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
        data-testid="articles-segment-error"
        className="rounded-xl border border-red-200 bg-red-50 px-6 py-8"
      >
        <h2 className="text-sm font-semibold text-red-900">文章数据读取失败</h2>
        <p className="mt-2 text-sm text-red-800">
          这不是「没有这篇文章」，而是本次查询没能完成。请重试；若持续失败，请带下方编号联系后端排查。
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
