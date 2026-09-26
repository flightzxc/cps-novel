export type SitemapRequestResult = { status: "disabled" } | { status: "queued" | "coalesced"; taskId: string };
export type SitemapAdminState = {
  enabled: boolean;
  task: { id: string; status: string; createdAt: string; completedAt: string | null } | null;
  lastGeneration: { status: string; finishedAt: string | null };
  published: { generatedAt: string; urlCount: number } | null;
};
