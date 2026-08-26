import "./setup-cleanup";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ManualReviewSection,
  type ManualReviewRow,
} from "@/app/(admin)/tasks/_components/manual-review-section";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function review(overrides: Partial<ManualReviewRow> = {}): ManualReviewRow {
  return {
    intentId: "77777777-7777-4777-8777-777777777777",
    operationType: "promo_link.claim_promo",
    targetType: "promo_link",
    targetId: "88888888-8888-4888-8888-888888888888",
    taskItemType: "generic",
    taskItemId: "99999999-9999-4999-8999-999999999999",
    channelAccountId: null,
    channelAppId: null,
    promoLinkId: null,
    committedAt: "2026-08-26T01:00:00.000Z",
    createdAt: "2026-08-26T00:59:00.000Z",
    ...overrides,
  };
}

describe("ManualReviewSection · 人工审查区", () => {
  it("空态说明「没有待裁决」，不是一句空白", () => {
    render(<ManualReviewSection reviews={[]} />);
    expect(screen.getByTestId("manual-review-empty-state").textContent).toContain("没有待人工裁决");
  });

  it("列出待裁决意图的标识字段，且不展示 null 字段", () => {
    render(<ManualReviewSection reviews={[review()]} />);
    const row = screen.getByTestId(`manual-review-row-${review().intentId}`);
    expect(row.textContent).toContain("promo_link.claim_promo");
    expect(row.textContent).toContain(review().targetId);
    expect(row.textContent).not.toContain("channel_account_id");
  });

  it("每一行都带有两个裁决按钮的入口", () => {
    render(<ManualReviewSection reviews={[review()]} />);
    expect(screen.getByTestId(`manual-review-confirm-effect-${review().intentId}`)).toBeTruthy();
    expect(screen.getByTestId(`manual-review-confirm-no-effect-${review().intentId}`)).toBeTruthy();
  });

  it("标题标注待裁决数量", () => {
    render(<ManualReviewSection reviews={[review(), review({ intentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })]} />);
    expect(screen.getByText(/待裁决副作用意图（2）/)).toBeTruthy();
  });
});
