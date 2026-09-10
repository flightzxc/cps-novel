import "./setup-cleanup";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminSessionView } from "@/contracts";
import type { AdminCanonicalTagItem, AdminCanonicalTagList, AdminTagAuthority } from "@/domain/tagging-admin";

/**
 * PR6 fix (lane F) · `/categories`.
 *
 * X8 fact: `src/server/tagging/admin-service.ts`'s `requireTaggingRead`
 * throws `TaggingAdminError("tagging_disabled", 403)` the instant
 * `FEATURE_P2_06_5_TAGGING` is off, and this page had no pre-check before
 * calling `listAdminCanonicalTags` — the throw reached the segment's error
 * boundary and rendered a generic "Something went wrong" instead of telling
 * the operator which env var to open. This proves the fix end to end: the
 * real `CategoriesPage` Server Component, invoked the same way
 * `admin-two-factor-setup-page.test.tsx` invokes its page (`await Page(...)`,
 * then `render(element)`), across all three flag combinations that matter.
 *
 * Everything AdminShell needs to render safely in jsdom is replaced the same
 * way `admin-shell-logout.test.tsx` does it (`logoutAction`, `AdminSidebar`);
 * `next/navigation`'s `useRouter` is replaced the same way
 * `admin-canonical-tags.test.tsx` does it, since `CanonicalTagsClient` is the
 * real component here too. `listAdminCanonicalTags` and `requireContentPage`
 * are the only two behavioural seams — everything else (the projector, the
 * disabled-panel component, `CanonicalTagsClient`, `ContentPagination`,
 * `ClassifierDiagnosticsPanel`) is the real, unmocked module.
 */

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const logoutAction = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/app/(admin-auth)/_lib/logout-action", () => ({ logoutAction }));

vi.mock("@/features/admin-ui/sidebar", () => ({
  AdminSidebar: () => <nav data-testid="stub-sidebar" />,
}));

const listAdminCanonicalTags = vi.hoisted(() => vi.fn());
vi.mock("@/server/tagging/admin-service", () => ({ listAdminCanonicalTags }));

vi.mock("@/app/api/admin/_lib/deps", () => ({ prisma: {} }));

const requireContentPage = vi.hoisted(() => vi.fn());
vi.mock("@/app/(admin)/novels/_lib/content-page-guard", () => ({ requireContentPage }));

const SESSION: AdminSessionView = {
  identityId: "id-1",
  username: "root",
  role: "super_admin",
  twoFactorCompleted: true,
  idleExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  capabilities: [{ capability: "tag:manage", state: "granted" }],
};

vi.mock("@/app/(admin)/_lib/page-guard", () => ({
  sessionView: () => SESSION,
  capabilityViews: () => SESSION.capabilities,
}));

const { default: CategoriesPage } = await import("@/app/(admin)/categories/page");

const TAG_ID = "11111111-1111-4111-8111-111111111111";

function canonicalTagItem(overrides: Partial<AdminCanonicalTagItem> = {}): AdminCanonicalTagItem {
  return {
    id: TAG_ID,
    stableId: "genre.wuxia",
    slug: "wuxia",
    active: true,
    canonicalDefinition: "武侠题材：以武功、江湖恩怨、侠义精神为核心叙事。",
    facet: "genre",
    sortOrder: 10,
    taxonomyVersion: "v1",
    translations: [{ locale: "zh", displayName: "武侠" }],
    aliases: ["武侠", "wuxia"],
    keywordSummary: { total: 2, active: 1, lexiconVersions: ["c1-v2"] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    lastMutation: null,
    ...overrides,
  };
}

function authorityFixture(overrides: Partial<AdminTagAuthority> = {}): AdminTagAuthority {
  return {
    taxonomy: {
      status: "READY",
      canonicalV1Count: 123,
      canonicalV1Sha256: "8bc8cdae8be2176bde170173e98bad2b9fa0e1770818174a57320816eefdccad",
      databaseActiveCount: 123,
      versions: ["v1"],
    },
    keywords: {
      status: "READY",
      activeKeywordCount: 40,
      versions: ["c1-v2"],
      fingerprint: "b".repeat(64),
      keywordEligibilityVersion: "keyword-eligibility-v2",
      keywordEligibilitySha256: "e796ba1ed79b344f790a70853d2e9773d6265e307615b2a60da28b90a6164854",
    },
    classifier: {
      status: "FROZEN",
      version: "2026-08-17-owner-final-c1-final",
      titleWeight: 30,
      descriptionWeight: 30,
      threshold: 30,
      maxTextTags: 3,
      fingerprint: "a".repeat(64),
    },
    ...overrides,
  };
}

function canonicalTagList(items: AdminCanonicalTagItem[]): AdminCanonicalTagList {
  return { items, page: 1, pageSize: 20, total: items.length, totalPages: 1, authority: authorityFixture() };
}

const ORIGINAL_ENV = { ...process.env };

function setFlags(input: { read: boolean; write: boolean }): void {
  process.env.FEATURE_P2_06_5_TAGGING = String(input.read);
  process.env.FEATURE_P2_06_5_TAG_ADMIN_WRITE = String(input.write);
}

beforeEach(() => {
  listAdminCanonicalTags.mockReset();
  requireContentPage.mockReset();
  requireContentPage.mockResolvedValue({ context: {}, granted: true });
  routerRefresh.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("PR6 fix (lane F): /categories renders a disabled-state panel instead of crashing", () => {
  it("FEATURE_P2_06_5_TAGGING=false: renders TaggingDisabledPanel and never calls listAdminCanonicalTags", async () => {
    setFlags({ read: false, write: false });
    const element = await CategoriesPage({ searchParams: Promise.resolve({}) });
    render(element);

    expect(screen.getByTestId("tagging-disabled-panel")).toBeTruthy();
    expect(screen.getByTestId(`tagging-flag-row-FEATURE_P2_06_5_TAGGING`).textContent).toContain("未开启");
    expect(screen.getByTestId(`tagging-flag-row-FEATURE_P2_06_5_TAG_ADMIN_WRITE`).textContent).toContain("未开启");
    expect(listAdminCanonicalTags).not.toHaveBeenCalled();
    // The RBAC-denied panel must not also render — these are two distinct gates.
    expect(screen.queryByTestId("content-capability-denied")).toBeNull();
  });

  it("read on, write off: renders real data read-only, with a write-disabled notice and a disabled editor", async () => {
    setFlags({ read: true, write: false });
    listAdminCanonicalTags.mockResolvedValue(canonicalTagList([canonicalTagItem()]));
    const element = await CategoriesPage({ searchParams: Promise.resolve({}) });
    render(element);

    expect(listAdminCanonicalTags).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("tagging-disabled-panel")).toBeNull();
    expect(screen.getByTestId("tagging-write-disabled-notice")).toBeTruthy();

    // The row itself renders (read-only data is real, not hidden) — expanding
    // its editor must come up pre-emptively disabled rather than only fail on
    // submit with `tag_write_not_authorized`.
    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${TAG_ID}`));
    const statusButton = screen
      .getByTestId(`canonical-tag-status-form-${TAG_ID}`)
      .querySelector("button[type=submit]");
    expect(statusButton).toBeTruthy();
    expect((statusButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("both flags on: renders normally, with neither the disabled panel nor the write-disabled notice, and a live editor", async () => {
    setFlags({ read: true, write: true });
    listAdminCanonicalTags.mockResolvedValue(canonicalTagList([canonicalTagItem()]));
    const element = await CategoriesPage({ searchParams: Promise.resolve({}) });
    render(element);

    expect(screen.queryByTestId("tagging-disabled-panel")).toBeNull();
    expect(screen.queryByTestId("tagging-write-disabled-notice")).toBeNull();

    fireEvent.click(screen.getByTestId(`canonical-tag-edit-${TAG_ID}`));
    const statusButton = screen
      .getByTestId(`canonical-tag-status-form-${TAG_ID}`)
      .querySelector("button[type=submit]");
    expect((statusButton as HTMLButtonElement).disabled).toBe(false);
  });
});
