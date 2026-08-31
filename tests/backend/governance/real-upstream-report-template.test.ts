import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const template = readFileSync(
  resolve(process.cwd(), "docs/governance/REAL_UPSTREAM_DIAGNOSTIC_REPORT_TEMPLATE.md"),
  "utf8",
);

describe("real upstream diagnostic report governance", () => {
  it("permanently requires account identity and exact request coordinates", () => {
    for (const required of [
      "账号身份（必填）",
      "JWT subject/account claim 名",
      "JWT subject/account claim 值",
      "ChannelAccount businessId",
      "独立身份比对",
      "scope 证据",
      "请求坐标（每次请求必填）",
      "pageSize",
      "projectType",
      "maxAttempts",
      "实际 attempts",
    ]) {
      expect(template).toContain(required);
    }
  });

  it("forbids secret material and distinguishes unexecuted work from success", () => {
    expect(template).toContain("不得记录 JWT、Cookie、Authorization、密钥");
    expect(template).toContain("未请求页不得写成零命中");
    expect(template).toContain("NOT_RUN");
    expect(template).toContain("扫描只输出计数，不输出命中值");
    expect(template).not.toMatch(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/);
  });
});
