import { ContentTableSkeleton } from "../novels/_components/content-states";

/** Streamed while the promo-link query runs — same rationale as `tags/loading.tsx`. */
export default function PromoLinksLoading() {
  return (
    <div className="space-y-6 px-6 py-6">
      <div className="h-10 w-full animate-pulse rounded-xl bg-gray-100" />
      <ContentTableSkeleton />
    </div>
  );
}
