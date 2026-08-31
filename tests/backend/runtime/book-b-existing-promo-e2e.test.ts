import { describe, expect, it, vi } from "vitest";

import { createPreviewOnlyFetch } from "../../../scripts/book-b-existing-promo-e2e";

function request(path: string, body: Record<string, unknown>) {
  return {
    input: `https://kocserver-cn.cdreader.com${path}`,
    init: { method: "POST", redirect: "error" as const, body: JSON.stringify(body) },
  };
}

describe("Book B existing-PromoLink E2E transport guard", () => {
  it("allows exactly the two fixed preview reads", async () => {
    const upstream = vi.fn(async () => new Response("{}", { status: 200 }));
    const network = { total: 0, getbydataid: 0, getchapterinfo: 0 };
    const guarded = createPreviewOnlyFetch(upstream, network);
    await guarded(...Object.values(request("/api/v1/material/getbydataid", {
      agencyId: "3366", dataId: "118274322", projectType: 1, language: "3", materialType: 1,
    })) as [string, RequestInit]);
    await guarded(...Object.values(request("/api/v1/res/getchapterinfo", {
      agencyId: "3366", seriesId: "118274322", projectType: 1, language: "3",
    })) as [string, RequestInit]);
    expect(network).toEqual({ total: 2, getbydataid: 1, getchapterinfo: 1 });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("fails closed before any getcode request", async () => {
    const upstream = vi.fn(async () => new Response("{}", { status: 200 }));
    const guarded = createPreviewOnlyFetch(upstream, { total: 0, getbydataid: 0, getchapterinfo: 0 });
    const getcode = request("/api/v1/res/getcode", {
      agencyId: "3366", seriesId: "118274322", projectType: 1, language: "3",
    });
    await expect(guarded(getcode.input, getcode.init)).rejects.toThrow("getcode_forbidden");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a third preview request and any coordinate drift", async () => {
    const upstream = vi.fn(async () => new Response("{}", { status: 200 }));
    const network = { total: 0, getbydataid: 0, getchapterinfo: 0 };
    const guarded = createPreviewOnlyFetch(upstream, network);
    const material = request("/api/v1/material/getbydataid", {
      agencyId: "3366", dataId: "118274322", projectType: 1, language: "3", materialType: 1,
    });
    await guarded(material.input, material.init);
    await expect(guarded(material.input, material.init)).rejects.toThrow("getbydataid_coordinate_violation");
    const drift = request("/api/v1/res/getchapterinfo", {
      agencyId: "3366", seriesId: "118274322", projectType: 2, language: "3",
    });
    await expect(guarded(drift.input, drift.init)).rejects.toThrow("preview_request_budget_exceeded");
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
