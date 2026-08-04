import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { hashAdminPassword, verifyAdminPassword } from "@/lib/auth";
import { ADMIN_CAPABILITY_CONFIG } from "@/lib/auth/capabilities";
import { CREDENTIAL_TASK_TYPES } from "@/lib/credentials/contracts";
import { resolveAdminAction, resolveAdminRoute } from "@/server/auth/registry";
import { P1_08B_ADMIN_REGISTRY } from "@/server/credentials";

async function sources(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(target);
    return entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name) ? readFile(target, "utf8") : "";
  }))).join("\n");
}

describe("P1-08B production backend contracts", () => {
  it("stores Admin passwords as versioned scrypt and fails closed", () => {
    const encoded = hashAdminPassword("a sufficiently long admin password");
    expect(encoded).toMatch(/^scrypt\$v1\$/);
    expect(encoded).not.toContain("sufficiently long");
    expect(verifyAdminPassword("a sufficiently long admin password", encoded)).toBe(true);
    expect(verifyAdminPassword("wrong password", encoded)).toBe(false);
    expect(verifyAdminPassword("a sufficiently long admin password", "not-versioned")).toBe(false);
  });

  it("registers validate and supersede but leaves replace default-denied", () => {
    expect(resolveAdminRoute("/api/admin/credentials/replace", "POST", P1_08B_ADMIN_REGISTRY)).toBeNull();
    expect(resolveAdminAction("admin.credential.replace", P1_08B_ADMIN_REGISTRY)).toBeNull();
    expect(resolveAdminAction("admin.credential.validate", P1_08B_ADMIN_REGISTRY)?.capability).toBe("credential:manage");
    expect(resolveAdminAction("admin.credential.supersede", P1_08B_ADMIN_REGISTRY)?.mutation).toBe(true);
    expect(ADMIN_CAPABILITY_CONFIG["credential:manage"].requiresTwoFactor).toBe(true);
    expect(CREDENTIAL_TASK_TYPES).toEqual({
      validate: "credential.validate.v1",
      supersede: "credential.supersede.v1",
      replaceGated: "credential.replace.v1",
    });
  });

  it("keeps Scheduler free of Credential execution and key material", async () => {
    const scheduler = await sources(path.resolve(process.cwd(), "scheduler"));
    expect(scheduler).not.toMatch(/worker\/handlers|createCredentialWorkerHandlers/);
    expect(scheduler).not.toMatch(/decryptCredential|CHANNEL_CREDENTIAL_/);
  });

  it("keeps task payload and redacted-result code free of prohibited fields", async () => {
    const service = await readFile(path.resolve(process.cwd(), "src/server/credentials/service.ts"), "utf8");
    const worker = await readFile(path.resolve(process.cwd(), "worker/handlers/credential.ts"), "utf8");
    const payloadLiteral = service.match(/const payload = \{([^}]+)\}/s)?.[1] ?? "";
    expect(payloadLiteral).toMatch(/channelAccountId/);
    expect(payloadLiteral).toMatch(/credentialId/);
    expect(payloadLiteral).toMatch(/mutationRequestId/);
    expect(payloadLiteral).not.toMatch(/secret|ciphertext|fingerprint|jwt/i);
    expect(`${service}\n${worker}`).not.toMatch(/result:\s*\{[^}]*stack/s);
  });
});
