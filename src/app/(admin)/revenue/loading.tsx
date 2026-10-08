import { ContentTableSkeleton } from "../novels/_components/content-states";

/** Streamed while the dashboard reads run — same rationale as `tasks/loading.tsx`. */
export default function RevenueLoading() {
  return (
    <div className="space-y-6 px-6 py-6">
      <div className="h-10 w-full animate-pulse rounded-xl bg-gray-100" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-24 animate-pulse rounded-xl bg-gray-100" />
        ))}
      </div>
      <ContentTableSkeleton />
      <ContentTableSkeleton rows={3} />
    </div>
  );
}
