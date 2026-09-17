import { describe, expect, it } from "vitest";

import {
  projectSafeTaskFailure,
  safeTaskFailureText,
} from "@/server/task-admin/safe-task-error";

describe("safe task error projection", () => {
  it.each([
    ["promo_link_missing", "缺少推广链接（promo_link_missing）"],
    ["missing_locale", "来源语言缺失（missing_locale）"],
    ["slug_unhealthy", "Slug 不符合要求（slug_unhealthy）"],
  ])("shows known business code %s", (code, expected) => {
    const failure = projectSafeTaskFailure({
      code,
      message: "Bearer secret-token stack raw payload",
    });
    expect(safeTaskFailureText(failure)).toBe(expected);
  });

  it("allowlists typed context and discards arbitrary detail", () => {
    const failure = projectSafeTaskFailure({
      code: "finalize_failed",
      message: "DATABASE_URL=postgres://secret",
      stack: "secret stack",
      detail: {
        sqlState: "23514",
        prismaCode: "P2010",
        constraint: "novel_metadata_check",
        credential: "secret",
        rawPayload: "secret",
      },
    });
    expect(failure).toEqual({
      code: "finalize_failed",
      label: "任务结果落库失败",
      context: { sqlState: "23514", prismaCode: "P2010", constraint: "novel_metadata_check" },
    });
    expect(JSON.stringify(failure)).not.toMatch(/DATABASE_URL|postgres|credential|rawPayload|stack|secret/);
  });

  it("withholds unknown codes and every raw exception field", () => {
    const failure = projectSafeTaskFailure({
      code: "handler_failed",
      message: "Authorization: Bearer eyJ.secret.value",
      stack: "raw stack",
      detail: { credential: "top-secret", rawPayload: "body" },
    });
    expect(failure).toBeUndefined();
    expect(safeTaskFailureText(failure)).toBe("系统异常，详情见审计/日志");
  });
});
