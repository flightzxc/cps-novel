import { ContentTableSkeleton } from "../novels/_components/content-states";

/** Streamed while the task/item/manual-review reads run — same rationale as `novels/loading.tsx`. */
export default function TasksLoading() {
  return (
    <div className="space-y-6 px-6 py-6">
      <div className="h-10 w-full animate-pulse rounded-xl bg-gray-100" />
      <ContentTableSkeleton />
      <ContentTableSkeleton rows={3} />
    </div>
  );
}
