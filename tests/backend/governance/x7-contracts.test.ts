import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function sha256(relativePath: string): string {
  return createHash("sha256").update(readFileSync(path.join(root, relativePath))).digest("hex");
}

describe("X7 governance closeout contracts", () => {
  it("keeps src/lib as a directory-only container", () => {
    const files = readdirSync(path.join(root, "src/lib"), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    expect(files).toEqual([]);
    expect(read("scripts/indexnow-backfill-apply.ts")).toContain("src/lib/indexnow/backfill-manifest");
    expect(read("scripts/indexnow-backfill-manifest.ts")).toContain("src/lib/indexnow/backfill-manifest");
  });

  it("registers one owner for indexnow, preview, and site", () => {
    const ownership = read("CLAUDE.md");
    expect(ownership).toContain("| `src/lib/indexnow/` | Codex |");
    expect(ownership).toContain("| `src/lib/preview/` | Codex |");
    expect(ownership).toContain("| `src/lib/site/` | **Claude** |");
  });

  it("archives both C2 reports byte-for-byte and treats 8/26 as authoritative", () => {
    expect(sha256("docs/governance/C2_REAL_UPSTREAM_READONLY_DIAGNOSTIC_2026-08-21.md")).toBe(
      "20e1bf8986e80e12eb31f2abcacab67f370805ea70eeedd368283531e5480003",
    );
    expect(sha256("docs/governance/C2_REAL_UPSTREAM_READONLY_DIAGNOSTIC_2026-08-26.md")).toBe(
      "2224e433933f1721796c8026e37903611658b82833b695e3d0ebedc08f56e893",
    );
    expect(read("docs/governance/C2_REAL_UPSTREAM_READONLY_DIAGNOSTIC_2026-08-26.md")).toContain(
      "本报告取代 2026-08-21",
    );
  });

  it("makes X11 and atomic flag+allowlist changes release-checklist facts", () => {
    const checklist = read("docs/p2/V020_RELEASE_CHECKLIST.md");
    expect(checklist).toContain("步骤 8–9 受 X11 硬门禁");
    expect(checklist).toContain("misfire=`skip`");
    expect(checklist).toContain("FEATURE_INDEXNOW_DELIVERY");
    expect(checklist).toContain("INDEXNOW_DELIVERY_ALLOW_WRITE");
    expect(checklist).toMatch(/indexnow_delivery[\s\S]{0,240}同一次发布变更|同一次发布变更[\s\S]{0,240}indexnow_delivery/);
  });

  it("records the exact eight-package audit composition without claiming sharp is absent", () => {
    const register = read("docs/governance/NPM_AUDIT_REGISTER_2026-08-26.md");
    for (const packageName of [
      "next",
      "postcss",
      "sharp",
      "prisma",
      "@prisma/config",
      "deepmerge-ts",
      "effect",
      "nanoid",
    ]) {
      expect(register).toContain(`\`${packageName}\``);
    }
    expect(register).toContain("high=8");
    expect(register).toContain("critical=0");
    expect(register).toContain("不得声称 sharp 不在生产镜像");
    expect(register).toContain("禁止运行或合入整体 `npm audit fix --force`");
  });

  it("preserves the X-series CPS reference as the peeled v8.2.18 commit", () => {
    expect(read("docs/governance/port-registry.md")).toContain(
      "0ec20c4ee08b4b007e773feab811703a59ac3048",
    );
  });
});
