/**
 * P0-S6: `scripts/set-channel-capability-status.ts`'s pure/orchestration
 * exports — `parseCliOptions` (argv/env parsing, no I/O) and `runCli`
 * (dry-run preview vs. `--apply` write, against an injectable db). `main()`
 * itself is untested here — it is thin glue that constructs a real
 * `PrismaClient` and is guarded by the CLI-entrypoint check, exactly like
 * the sibling `scripts/indexnow-backfill-apply.ts` pattern
 * (`tests/backend/indexnow/backfill-apply-gates.test.ts`).
 */
import { describe, expect, it } from "vitest";

import { CliArgumentError, parseCliOptions, runCli, type CliOptions } from "../../../scripts/set-channel-capability-status";
import { ChannelCapabilityStatusError } from "@/server/channel-capability/service";

import { FakeChannelCapabilityDb } from "./fake-db";

const ENV = { CHANNEL_CAPABILITY_OPERATOR: "operator-1" } as unknown as NodeJS.ProcessEnv;

describe("parseCliOptions", () => {
  it("refuses to run at all without CHANNEL_CAPABILITY_OPERATOR, even for a dry-run", () => {
    expect(() =>
      parseCliOptions(
        ["--channel-app", "a", "--capability", "b", "--to", "enabled", "--reason", "r"],
        {} as NodeJS.ProcessEnv,
      ),
    ).toThrow(CliArgumentError);
  });

  it("parses required flags and defaults --apply to false", () => {
    const options = parseCliOptions(
      ["--channel-app", "app-1", "--capability", "sync.catalog", "--to", "enabled", "--reason", "why"],
      ENV,
    );
    expect(options).toMatchObject({
      channelAppId: "app-1",
      capabilityKey: "sync.catalog",
      targetStatus: "enabled",
      reason: "why",
      evidenceRef: undefined,
      apply: false,
      operatorId: "operator-1",
    });
  });

  it("recognizes --apply and --evidence", () => {
    const options = parseCliOptions(
      [
        "--channel-app", "app-1",
        "--capability", "sync.catalog",
        "--to", "enabled",
        "--reason", "why",
        "--evidence", "smoke-2026-08-20.md",
        "--apply",
      ],
      ENV,
    );
    expect(options.apply).toBe(true);
    expect(options.evidenceRef).toBe("smoke-2026-08-20.md");
  });

  it("requires --channel-app, --capability, --to, and --reason", () => {
    expect(() => parseCliOptions(["--capability", "b", "--to", "enabled", "--reason", "r"], ENV)).toThrow(CliArgumentError);
    expect(() => parseCliOptions(["--channel-app", "a", "--to", "enabled", "--reason", "r"], ENV)).toThrow(CliArgumentError);
    expect(() => parseCliOptions(["--channel-app", "a", "--capability", "b", "--reason", "r"], ENV)).toThrow(CliArgumentError);
    expect(() => parseCliOptions(["--channel-app", "a", "--capability", "b", "--to", "enabled"], ENV)).toThrow(CliArgumentError);
  });

  // P0-S10 (2026-08-20) regression: a flag whose value token was dropped
  // must never silently swallow the *next* flag as its value — see `arg()`
  // in scripts/set-channel-capability-status.ts.
  describe("does not swallow a following flag as a dropped value (P0-S10)", () => {
    it("--evidence immediately followed by --apply throws instead of setting evidenceRef='--apply' and apply=true", () => {
      expect(() =>
        parseCliOptions(
          [
            "--channel-app", "a",
            "--capability", "b",
            "--to", "enabled",
            "--reason", "r",
            "--evidence", "--apply",
          ],
          ENV,
        ),
      ).toThrow(CliArgumentError);
    });

    it("--reason immediately followed by another flag throws rather than adopting the flag text as the reason", () => {
      expect(() =>
        parseCliOptions(
          ["--channel-app", "a", "--capability", "b", "--to", "enabled", "--reason", "--evidence"],
          ENV,
        ),
      ).toThrow(CliArgumentError);
    });

    it("a required flag with no value at all (end of argv) still throws", () => {
      expect(() =>
        parseCliOptions(["--channel-app", "a", "--capability", "b", "--to", "enabled", "--reason"], ENV),
      ).toThrow(CliArgumentError);
    });

    it("an --evidence value that legitimately does not start with -- is still accepted", () => {
      const options = parseCliOptions(
        [
          "--channel-app", "a",
          "--capability", "b",
          "--to", "enabled",
          "--reason", "r",
          "--evidence", "smoke-2026-08-20.md",
          "--apply",
        ],
        ENV,
      );
      expect(options.evidenceRef).toBe("smoke-2026-08-20.md");
      expect(options.apply).toBe(true);
    });

    it("an optional flag that is simply absent (not dropped) still parses fine — --evidence omitted entirely for a disable", () => {
      const options = parseCliOptions(
        ["--channel-app", "a", "--capability", "b", "--to", "registered_disabled", "--reason", "r"],
        ENV,
      );
      expect(options.evidenceRef).toBeUndefined();
    });
  });
});

function seedDisabled(db: FakeChannelCapabilityDb) {
  db.seedCapability({ id: "capability-1", channelAppId: "app-1", capabilityKey: "sync.catalog", status: "registered_disabled" });
  return db;
}

const BASE_OPTIONS: CliOptions = {
  channelAppId: "app-1",
  capabilityKey: "sync.catalog",
  targetStatus: "enabled",
  reason: "smoke test passed",
  evidenceRef: "smoke-2026-08-20.md",
  apply: false,
  operatorId: "operator-1",
};

describe("runCli: dry-run (no --apply)", () => {
  it("prints the current and proposed status and performs zero writes", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    const report = await runCli(db.asPrismaClient(), BASE_OPTIONS, "req-dry-1");

    expect(report).toEqual({
      mode: "dry-run",
      channelAppId: "app-1",
      capabilityKey: "sync.catalog",
      currentStatus: "registered_disabled",
      proposedStatus: "enabled",
      reason: "smoke test passed",
      evidenceRef: "smoke-2026-08-20.md",
    });
    // Zero writes: no update or audit call was ever issued.
    expect(db.calls).not.toContain("channelCapability.update");
    expect(db.calls).not.toContain("operationAudit.create");
    expect(db.audits).toHaveLength(0);
    expect(db.capabilities.get("capability-1")?.status).toBe("registered_disabled");
  });

  it("still runs validation in dry-run mode — evidence_required surfaces before any write", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    await expect(
      runCli(db.asPrismaClient(), { ...BASE_OPTIONS, evidenceRef: undefined }, "req-dry-2"),
    ).rejects.toMatchObject({ code: "evidence_required" });
    expect(db.calls).not.toContain("channelCapability.update");
  });

  it("surfaces capability_not_found for an unknown key without writing", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    await expect(
      runCli(db.asPrismaClient(), { ...BASE_OPTIONS, capabilityKey: "does.not.exist" }, "req-dry-3"),
    ).rejects.toBeInstanceOf(ChannelCapabilityStatusError);
    expect(db.calls).not.toContain("channelCapability.update");
  });
});

describe("runCli: --apply", () => {
  it("writes the change and reports before/after status and the audit id", async () => {
    const db = seedDisabled(new FakeChannelCapabilityDb());

    const report = await runCli(db.asPrismaClient(), { ...BASE_OPTIONS, apply: true }, "req-apply-1");

    expect(report).toMatchObject({
      mode: "apply",
      channelAppId: "app-1",
      capabilityKey: "sync.catalog",
      beforeStatus: "registered_disabled",
      afterStatus: "enabled",
      wrote: true,
    });
    if (report.mode === "apply") expect(report.auditId).toBe("1");
    expect(db.capabilities.get("capability-1")?.status).toBe("enabled");
    expect(db.audits).toHaveLength(1);
  });
});
