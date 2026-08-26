import "./setup-cleanup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PromoLinksTable, type PromoLinkRow } from "@/app/(admin)/promo-links/_components/promo-links-table";

function link(overrides: Partial<PromoLinkRow> = {}): PromoLinkRow {
  return {
    promoLinkId: "22222222-2222-4222-8222-222222222222",
    novelId: "33333333-3333-4333-8333-333333333333",
    novelSourceItemId: "44444444-4444-4444-8444-444444444444",
    channelAppId: "55555555-5555-4555-8555-555555555555",
    channelAccountId: "66666666-6666-4666-8666-666666666666",
    offerType: "standard",
    origin: "upstream_existing",
    publicRedirectCode: "abc123",
    status: "fetched",
    errorKind: null,
    fetchedAt: "2026-08-26T02:00:00.000Z",
    expiresAt: null,
    lastAttemptedAt: "2026-08-26T02:00:00.000Z",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-26T02:00:00.000Z",
    ...overrides,
  };
}

describe("PromoLinksTable · 空态", () => {
  it("给出可操作的空态指引", () => {
    render(<PromoLinksTable links={[]} />);
    expect(screen.getByTestId("promo-links-empty-state").textContent).toMatch(/筛选|novelId/);
  });
});

describe("PromoLinksTable · 状态与 errorKind 人话映射", () => {
  it("成功获取的行不展示告警文案", () => {
    render(<PromoLinksTable links={[link()]} />);
    expect(screen.getByTestId(`promo-link-status-${link().promoLinkId}`).textContent).toBe("已获取");
    expect(screen.getByText("已成功获取")).toBeTruthy();
  });

  it("existing_evidence_redacted 展示「本地证据被脱敏」而不是原始 errorKind 字符串", () => {
    render(<PromoLinksTable links={[link({ status: "pending", errorKind: "existing_evidence_redacted" })]} />);
    expect(screen.getByText(/本地证据被脱敏/)).toBeTruthy();
    expect(screen.queryByText("existing_evidence_redacted")).toBeNull();
  });

  it("claim_manual_review_required 给出跳转任务中心人工审查区的链接", () => {
    render(<PromoLinksTable links={[link({ status: "pending", errorKind: "claim_manual_review_required" })]} />);
    const goto = screen.getByTestId("promo-link-goto-manual-review-claim_manual_review_required") as HTMLAnchorElement;
    expect(goto.getAttribute("href")).toBe("/tasks#manual-review-heading");
  });

  it("capability_disabled 不展示跳转链接（不是本页能处理的问题）", () => {
    render(<PromoLinksTable links={[link({ status: "registered_disabled", errorKind: "capability_disabled" })]} />);
    expect(screen.queryByTestId("promo-link-goto-manual-review-capability_disabled")).toBeNull();
    expect(screen.getByText(/领取能力已冻结/)).toBeTruthy();
  });

  it("展示公开短码与时间字段（不带时区后缀，AdminTimeZoneNote 单独声明在页面级）", () => {
    render(<PromoLinksTable links={[link()]} />);
    expect(screen.getByText("abc123")).toBeTruthy();
    const cells = screen.getAllByText((_, element) => element?.textContent?.includes("2026") ?? false);
    for (const cell of cells) {
      expect(cell.textContent).not.toMatch(/UTC|GMT/);
    }
  });
});
