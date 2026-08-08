import { ContentTableSkeleton } from "./_components/content-states";

/**
 * Streamed while the novel list query runs.
 *
 * The list is a raw aggregate over five CTEs, so on a large catalogue it is not
 * instant; without this the route segment would hold the previous screen and
 * look frozen.
 */
export default function NovelsLoading() {
  return (
    <div className="space-y-6 px-6 py-6">
      <div className="h-10 w-full animate-pulse rounded-xl bg-gray-100" />
      <ContentTableSkeleton />
    </div>
  );
}
