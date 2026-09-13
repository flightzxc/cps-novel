"use client";

import { useEffect } from "react";
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
export function TaskDetailProgress({ taskId, materializing = false }: { taskId: string; materializing?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!materializing) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [materializing, router]);
  return <ImportProgress taskId={taskId} onTerminal={() => router.refresh()} />;
}
