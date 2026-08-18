import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertAllowedFlags,
  assertDatabaseUrlFingerprint,
  assertTmpOutputPath,
  databaseUrlSha256,
  redactSensitive,
} from "../../../scripts/lib/acceptance-safety";

const cleanup: string[] = [];

afterEach(() => {
  for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("P2-12 acceptance CLI safety gates", () => {
  it("allows only absolute /tmp output and rejects a symlink escape", () => {
    expect(assertTmpOutputPath("/tmp/p2-12/report.json")).toBe("/tmp/p2-12/report.json");
    expect(() => assertTmpOutputPath("relative/report.json")).toThrow(/absolute/);
    expect(() => assertTmpOutputPath(path.resolve(process.cwd(), "report.json"))).toThrow(/\/tmp/);

    const tmp = fs.mkdtempSync("/tmp/p2-12-safety-");
    cleanup.push(tmp);
    fs.symlinkSync(process.cwd(), path.join(tmp, "escape"), "dir");
    expect(() => assertTmpOutputPath(path.join(tmp, "escape", "report.json"))).toThrow(/outside/);
  });

  it("cross-checks DATABASE_URL by fingerprint without echoing the URL", () => {
    const databaseUrl = "postgresql://acceptance:secret@localhost:5432/cps_novel_acceptance";
    const fingerprint = databaseUrlSha256(databaseUrl);
    expect(() => assertDatabaseUrlFingerprint(fingerprint, databaseUrl)).not.toThrow();
    expect(() => assertDatabaseUrlFingerprint("0".repeat(64), databaseUrl)).toThrow(/mismatch/);
  });

  it("rejects unknown credential-like flags and recursively redacts output", () => {
    expect(() => assertAllowedFlags(["--output", "/tmp/x"], ["output"])).not.toThrow();
    expect(() => assertAllowedFlags(["--admin-token=raw"], ["output"])).toThrow(/credential-like/);
    expect(redactSensitive({
      databaseUrl: "postgresql://user:pw@db.example/prod",
      nested: ["token=abc", "https://signed.example/x"],
    })).toEqual({
      databaseUrl: "<redacted:sensitive_key>",
      nested: ["token=<redacted>", "<redacted:url_or_jwt>"],
    });
  });
});
