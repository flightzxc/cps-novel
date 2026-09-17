import { ContentTableSkeleton } from "../../novels/_components/content-states";

/**
 * Streamed while the mapping query runs — same rationale as
 * `tags/canonical/loading.tsx`: two placeholder bars (the fuzzy/exact filter
 * bar, then the create-mapping form) ahead of the table skeleton, so the
 * route segment does not hold the previous screen and look frozen while the
 * join over `channelApp` / `canonicalTag` / `approver` resolves.
 */
export default function TagMappingsLoading() {
  return (
    <div className="space-y-6 px-6 py-6">
      <div className="h-10 w-full animate-pulse rounded-xl bg-gray-100" />
      <div className="h-10 w-full animate-pulse rounded-xl bg-gray-100" />
      <ContentTableSkeleton />
    </div>
  );
}
