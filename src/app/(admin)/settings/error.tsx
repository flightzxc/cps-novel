"use client";

/**
 * Error boundary for the `/settings` segment. Same contract as
 * `novels/error.tsx` / `tags/error.tsx`: nothing from `error.message` is
 * rendered — only `digest` ever reaches the screen.
 *
 * The one error this page's own read can throw that a boundary is worth
 * having for is `SiteSettingNotSeededError` (`site_setting_not_seeded`):
 * the v0.2.0 foundation migration seeds the singleton row and a CHECK
 * forbids any other id, so a missing row means a broken migration state,
 * not a "no data yet" screen — this boundary keeps that failure from
 * rendering as a blank Next.js crash page.
 */
export default function SettingsError({
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
        data-testid="settings-segment-error"
        className="rounded-xl border border-red-200 bg-red-50 px-6 py-8"
      >
        <h2 className="text-sm font-semibold text-red-900">站点设置读取失败</h2>
        <p className="mt-2 text-sm text-red-800">
          本次查询没能完成，不代表设置已丢失。请重试；若持续失败，请带下方编号联系后端排查。
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
