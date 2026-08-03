import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CREDENTIAL_STATUSES, DATABASE_STATUS_SEMANTICS } from "@/domain/database-statuses";

const root = process.cwd();
const initialMigration = readFileSync(
  path.join(root, "prisma/migrations/20260803090000_p1_initial_schema/migration.sql"),
  "utf8",
);
const parityMigration = readFileSync(
  path.join(
    root,
    "prisma/migrations/20260804090000_p1_08_credential_status_parity/migration.sql",
  ),
  "utf8",
);

describe("P1-08 credential status migration contract", () => {
  it("keeps the initial migration immutable and replaces its CHECK incrementally", () => {
    expect(initialMigration).toContain(
      "CHECK (\"status\" IN ('active', 'superseded', 'revoked', 'expired'))",
    );
    expect(parityMigration).toContain(
      "CHECK (\"status\" IN ('active', 'superseded', 'expired', 'invalid'))",
    );
    expect(parityMigration).toContain(
      'DROP CONSTRAINT "channel_account_credential_status_check"',
    );
  });

  it("blocks revoked rows for explicit manual disposition", () => {
    expect(parityMigration).toContain("WHERE \"status\" = 'revoked'");
    expect(parityMigration).toContain("manual disposition is required before retrying");
    expect(parityMigration).not.toMatch(/UPDATE[\s\S]+revoked/i);
  });

  it("keeps the TypeScript status source and semantics on exactly four values", () => {
    expect(CREDENTIAL_STATUSES).toEqual(["active", "superseded", "expired", "invalid"]);
    expect(Object.keys(DATABASE_STATUS_SEMANTICS.channel_account_credential)).toEqual(
      CREDENTIAL_STATUSES,
    );
    expect(CREDENTIAL_STATUSES).not.toContain("disabled");
    expect(CREDENTIAL_STATUSES).not.toContain("revoked");
  });
});
