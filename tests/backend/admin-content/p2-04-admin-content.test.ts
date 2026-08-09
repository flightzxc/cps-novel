import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import {
  ADMIN_CONTENT_DEFAULT_PAGE_SIZE,
  ADMIN_CONTENT_MAX_PAGE_SIZE,
} from "@/domain/admin-content";
import {
  AdminContentQueryError,
  getAdminNovelDetail,
  listAdminNovels,
  normalizeAdminChapterListInput,
  normalizeAdminNovelListInput,
  readAdminChapterContent,
} from "@/server/admin-content";

const NOVEL_ID = "24040000-0000-4000-8000-000000000001";
const CHAPTER_ID = "24040000-0000-4000-8000-000000000002";
const NOW = new Date("2026-08-08T00:00:00.000Z");

function queryDb(results: unknown[]) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  return { db: { $queryRaw: query } as unknown as PrismaClient, query };
}

function listRow() {
  return {
    id: NOVEL_ID,
    business_id: "book-secret-safe",
    title: "Visible title",
    cover_url: null,
    locale: "en",
    slug: "visible-title",
    author: null,
    completion_status: null,
    total_chapter_count: 999,
    paid_from_chapter: 4,
    split_ratio: "0.5000",
    status: "ready",
    actual_chapter_row_count: "2",
    actual_materialized_count: "1",
    actual_displayable_count: "1",
    policy_materialization_policy: "upstream_returned_preview",
    policy_materialized_count: 2,
    policy_display_authorized: true,
    policy_index_authorized: true,
    policy_cache_authorized: true,
    policy_max_materialized_chapters: 3,
    policy_last_refreshed_at: NOW,
    policy_created_at: NOW,
    policy_updated_at: NOW,
    source_item_count: "1",
    source_app_codes: ["moboreader"],
    latest_source_updated_at: NOW,
    latest_seen_at: NOW,
    source_stale_count: "1",
    chapter_failed_count: "1",
    sync_task_id: "24040000-0000-4000-8000-000000000003",
    sync_task_type: "preview_materialization",
    sync_task_status: "completed_with_errors",
    sync_item_status: "failed",
    sync_mode: "apply",
    sync_attempt_count: 2,
    sync_requested_at: NOW,
    sync_started_at: NOW,
    sync_finished_at: NOW,
    sync_updated_at: NOW,
    created_at: NOW,
    updated_at: NOW,
  };
}

describe("P2-04 admin content query validation", () => {
  it("applies bounded pagination defaults", () => {
    expect(normalizeAdminNovelListInput({})).toMatchObject({
      page: 1,
      pageSize: ADMIN_CONTENT_DEFAULT_PAGE_SIZE,
      offset: 0,
    });
    expect(normalizeAdminNovelListInput({ page: 2, pageSize: ADMIN_CONTENT_MAX_PAGE_SIZE }))
      .toMatchObject({ page: 2, pageSize: 100, offset: 100 });
  });

  it.each([
    [{ page: 0 }, "invalid_page"],
    [{ page: 1.2 }, "invalid_page"],
    [{ pageSize: 0 }, "invalid_page_size"],
    [{ pageSize: ADMIN_CONTENT_MAX_PAGE_SIZE + 1 }, "invalid_page_size"],
    [{ status: "active" }, "invalid_status"],
    [{ locale: "fr" }, "invalid_locale"],
    [{ search: "x".repeat(161) }, "invalid_search"],
  ])("fails safely for invalid list input %#", (input, code) => {
    try {
      normalizeAdminNovelListInput(input as never);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AdminContentQueryError);
      expect((error as AdminContentQueryError).code).toBe(code);
    }
  });

  it("validates chapter status and identifiers without touching a database", () => {
    expect(() => normalizeAdminChapterListInput({ novelId: "not-a-uuid" }))
      .toThrowError(AdminContentQueryError);
    expect(() => normalizeAdminChapterListInput({ novelId: NOVEL_ID, status: "published" as never }))
      .toThrowError(AdminContentQueryError);
  });
});

describe("P2-04 admin content projections", () => {
  it("returns an empty page in exactly two database queries", async () => {
    const { db, query } = queryDb([[{ count: "0" }], []]);
    await expect(listAdminNovels(db, {})).resolves.toEqual({
      items: [],
      page: 1,
      pageSize: 20,
      total: 0,
      totalPages: 0,
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("projects only allowlisted fields and derives safe exception codes", async () => {
    const { db, query } = queryDb([[{ count: "1" }], [listRow()]]);
    const result = await listAdminNovels(db, { search: "Visible" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(result.items[0]).toMatchObject({
      id: NOVEL_ID,
      totalChapterCount: 999,
      actualChapterRowCount: 2,
      preview: {
        actualMaterializedChapterCount: 1,
        policyCountMatchesActual: false,
      },
      sync: {
        exceptions: [
          "source_item_stale",
          "chapter_materialization_failed",
          "sync_item_failed",
          "sync_completed_with_errors",
          "preview_count_mismatch",
        ],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("raw_payload");
    expect(serialized).not.toContain("encrypted_secret");
    expect(serialized).not.toContain("task error private payload");
    expect(serialized).not.toContain("body");
  });

  it("runs a fixed, constant number of queries regardless of source/label row count (no N+1)", async () => {
    const { db, query } = queryDb([[], [], []]);
    await expect(getAdminNovelDetail(db, NOVEL_ID)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("audits a successful body read without copying content metadata into Audit", async () => {
    const audit = vi.fn().mockResolvedValue({ id: 1n });
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{
        chapter_id: CHAPTER_ID,
        novel_id: NOVEL_ID,
        canonical_chapter_number: 1,
        chapter_title: "Chapter one",
        status: "preview",
        body: "copyrighted-body-sentinel",
        char_count: 25,
        content_hash: "a".repeat(64),
        materialized_at: NOW,
        updated_at: NOW,
      }]),
      operationAudit: { create: audit },
    };
    const db = {
      $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
    } as unknown as PrismaClient;
    const result = await readAdminChapterContent(db, {
      novelId: NOVEL_ID,
      chapterId: CHAPTER_ID,
      context: { actorId: "admin-1", requestId: "request-1" },
    });
    expect(result?.body).toBe("copyrighted-body-sentinel");
    expect(audit).toHaveBeenCalledWith({
      data: {
        actorType: "admin",
        actorId: "admin-1",
        action: "admin.chapter_content.read",
        entityType: "novel_chapter",
        entityId: CHAPTER_ID,
        requestId: "request-1",
      },
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("copyrighted-body-sentinel");
    expect(JSON.stringify(audit.mock.calls)).not.toContain("a".repeat(64));
  });
});
