import { ContentTableSkeleton } from "../novels/_components/content-states";

/**
 * Streamed while the source-label query runs — same rationale as
 * `novels/loading.tsx`: the aggregate `novelCount` per label is not free, so
 * without this the route segment would hold the previous screen and look
 * frozen.
 */
export default function TagsLoading() {
  return (
    <div className="space-y-6 px-6 py-6">
      <div className="h-10 w-full animate-pulse rounded-xl bg-gray-100" />
      <ContentTableSkeleton />
    </div>
  );
}
