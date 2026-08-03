import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CREDENTIAL_EXECUTION_STATUS,
  CREDENTIAL_SCHEDULER_EXECUTION_ALLOWED,
  type CredentialContractCode,
} from "@/lib/credentials/contracts";

describe("credential web boundary", () => {
  it("defines all redacted task result codes while execution remains deferred", () => {
    const codes: CredentialContractCode[] = [
      "credential_validation_queued",
      "credential_missing",
      "credential_expired",
      "credential_fingerprint_conflict",
      "credential_validation_failed",
      "credential_capability_denied",
    ];
    expect(new Set(codes).size).toBe(6);
    expect(CREDENTIAL_EXECUTION_STATUS).toBe("NOT_IMPLEMENTED");
    expect(CREDENTIAL_SCHEDULER_EXECUTION_ALLOWED).toBe(false);
  });

  it("contains no Credential secret read, crypto, or decryption entry point", async () => {
    async function typescriptSources(directory: string): Promise<string[]> {
      const entries = await readdir(directory, { withFileTypes: true });
      const nested = await Promise.all(
        entries.map(async (entry) => {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory()) return typescriptSources(target);
          return entry.isFile() && entry.name.endsWith(".ts") ? [await readFile(target, "utf8")] : [];
        }),
      );
      return nested.flat();
    }

    const source = (
      await Promise.all(
        ["src/lib/credentials", "src/server"].map((directory) =>
          typescriptSources(path.resolve(process.cwd(), directory)),
        ),
      )
    )
      .flat()
      .join("\n");
    expect(source).not.toMatch(/encrypted[_A-Z]?secret/i);
    expect(source).not.toMatch(/decrypt|createDecipheriv|CHANNEL_CREDENTIAL_ENCRYPTION_KEY/);
    expect(source).not.toMatch(/node:crypto/);
  });
});
