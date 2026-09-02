import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadCredentialKeyring } from "@/lib/credentials/keyring";

const directories: string[] = [];

function secretFile(value = randomBytes(32).toString("base64")): string {
  const directory = mkdtempSync(path.join(tmpdir(), "cps-novel-keyring-"));
  directories.push(directory);
  const target = path.join(directory, "secret");
  writeFileSync(target, value, { mode: 0o600 });
  return target;
}

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "2",
    CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE: secretFile(),
    CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V2_FILE: secretFile(),
    CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE: secretFile(),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("P0-1 Credential secret-file keyring", () => {
  it("loads every declared version and selects the active version", () => {
    const keyring = loadCredentialKeyring(validEnvironment());
    expect(keyring.activeVersion).toBe(2);
    expect(keyring.declaredVersions).toEqual([1, 2]);
    expect(keyring.encryptionKey(1)).toHaveLength(32);
    expect(keyring.encryptionKey(2)).toHaveLength(32);
    expect(keyring.fingerprintKey).toHaveLength(32);
  });

  it("fails startup when any inactive declared file is unreadable or non-canonical", () => {
    const unreadable = validEnvironment();
    unreadable.CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE = "/definitely/missing/credential-v1";
    expect(() => loadCredentialKeyring(unreadable)).toThrow(/readable secret file/);

    const malformed = validEnvironment();
    malformed.CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE = secretFile("not-canonical-base64");
    expect(() => loadCredentialKeyring(malformed)).toThrow(/canonical 32-byte base64/);
  });

  it("fails when active has no declared file", () => {
    const env = validEnvironment();
    env.CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION = "3";
    expect(() => loadCredentialKeyring(env)).toThrow(/does not have a declared secret file/);
  });

  it("rejects legacy key-material env variables instead of falling back", () => {
    const encryptionEnv = {
      ...validEnvironment(),
      CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1: randomBytes(32).toString("base64"),
    };
    expect(() => loadCredentialKeyring(encryptionEnv)).toThrow(/is forbidden/);

    const fingerprintEnv = {
      ...validEnvironment(),
      CHANNEL_CREDENTIAL_FINGERPRINT_KEY: randomBytes(32).toString("base64"),
    };
    expect(() => loadCredentialKeyring(fingerprintEnv)).toThrow(/is forbidden/);
  });
});
