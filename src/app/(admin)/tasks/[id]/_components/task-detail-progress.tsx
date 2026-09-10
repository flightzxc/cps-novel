"use client";

import { useRouter } from "next/navigation";

import { ImportProgress } from "@/features/admin-ui/import-progress";

/**
 * C-9 (task-detail route, Phase E rework, 2026-09-07): thin client wrapper
 * around the Phase C `ImportProgress` port — only reason this file exists
 * is `useRouter`, which needs a Client Component; `page.tsx` itself stays a
 * Server Component. Same `onTerminal={() => router.refresh()}` wiring as
 * `catalog-scan-trigger-form.tsx`'s `TaskProgressCard`: once the polled
 * status turns terminal, a single `router.refresh()` re-runs the page's
 * server-side reads so the summary cards / items table below (which never
 * poll themselves) catch up to the final counts without a second polling
 * loop.
 */
export function TaskDetailProgress({ taskId }: { taskId: string }) {
  const router = useRouter();
  return <ImportProgress taskId={taskId} onTerminal={() => router.refresh()} />;
}
