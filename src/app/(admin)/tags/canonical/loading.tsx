import { ContentTableSkeleton } from "../../novels/_components/content-states";

/**
 * Streamed while the Canonical Tag query runs — same rationale as
 * `tags/loading.tsx`: the list join (translations + keywords + authority
 * aggregates) is not free, so without this the route segment would hold the
 * previous screen and look frozen.
 */
export default function CanonicalTagsLoading() {
  return (
    <div className="space-y-6 px-6 py-6">
      <div className="h-10 w-full animate-pulse rounded-xl bg-gray-100" />
      <div className="h-10 w-full animate-pulse rounded-xl bg-gray-100" />
      <ContentTableSkeleton />
    </div>
  );
}
