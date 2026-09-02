import { readFileSync } from "node:fs";

const ENCRYPTION_KEY_FILE_PATTERN = /^CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V([1-9]\d*)_FILE$/;
const ENCRYPTION_KEY_FILE_PREFIX = "CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V";
const FINGERPRINT_KEY_FILE = "CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE";
const ACTIVE_KEY_VERSION = "CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION";

const LEGACY_FINGERPRINT_KEY = "CHANNEL_CREDENTIAL_FINGERPRINT_KEY";
const LEGACY_ENCRYPTION_KEY_PATTERN = /^CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V[1-9]\d*$/;

export type CredentialKeyring = Readonly<{
  activeVersion: number;
  declaredVersions: readonly number[];
  encryptionKey(version: number): Buffer;
  fingerprintKey: Buffer;
}>;

function canonicalKeyFromFile(env: NodeJS.ProcessEnv, fileVariable: string): Buffer {
  const filePath = env[fileVariable]?.trim() ?? "";
  if (!filePath) {
    throw new Error(`${fileVariable} must reference a readable secret file`);
  }

  let value: string;
  try {
    value = readFileSync(filePath, "utf8").trim();
  } catch {
    throw new Error(`${fileVariable} must reference a readable secret file`);
  }

  const decoded = Buffer.from(value, "base64");
  if (!value || decoded.length !== 32 || decoded.toString("base64") !== value) {
    throw new Error(`${fileVariable} must contain canonical 32-byte base64`);
  }
  return decoded;
}

function assertNoLegacyCredentialKeyEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (name === LEGACY_FINGERPRINT_KEY || LEGACY_ENCRYPTION_KEY_PATTERN.test(name)) {
      throw new Error(`${name} is forbidden; credential key material must use secret files`);
    }
  }
}

function activeVersionFromEnvironment(env: NodeJS.ProcessEnv): number {
  const value = env[ACTIVE_KEY_VERSION]?.trim() ?? "";
  const version = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(version)) {
    throw new Error(`${ACTIVE_KEY_VERSION} must be a positive integer`);
  }
  return version;
}

/**
 * Load and validate the complete declared Credential keyring. A version is
 * declared only by a CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V{n}_FILE variable;
 * every declared file is checked before any key is returned. Key material has
 * deliberately no environment-variable fallback.
 */
export function loadCredentialKeyring(
  env: NodeJS.ProcessEnv = process.env,
): CredentialKeyring {
  assertNoLegacyCredentialKeyEnvironment(env);

  const files = new Map<number, string>();
  for (const name of Object.keys(env)) {
    if (!name.startsWith(ENCRYPTION_KEY_FILE_PREFIX) || !name.endsWith("_FILE")) continue;
    const match = name.match(ENCRYPTION_KEY_FILE_PATTERN);
    if (!match) {
      throw new Error(`${name} is not a valid versioned credential key file declaration`);
    }
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version)) {
      throw new Error(`${name} is not a valid versioned credential key file declaration`);
    }
    files.set(version, name);
  }
  if (files.size === 0) {
    throw new Error("At least one versioned credential encryption key file must be declared");
  }

  const activeVersion = activeVersionFromEnvironment(env);
  if (!files.has(activeVersion)) {
    throw new Error(`${ACTIVE_KEY_VERSION} does not have a declared secret file`);
  }

  const encryptionKeys = new Map<number, Buffer>();
  const declaredVersions = [...files.keys()].sort((left, right) => left - right);
  for (const version of declaredVersions) {
    encryptionKeys.set(version, canonicalKeyFromFile(env, files.get(version)!));
  }
  const fingerprintKey = canonicalKeyFromFile(env, FINGERPRINT_KEY_FILE);

  return Object.freeze({
    activeVersion,
    declaredVersions: Object.freeze(declaredVersions),
    encryptionKey(version: number): Buffer {
      const key = encryptionKeys.get(version);
      if (!key) throw new Error(`Credential encryption key version ${version} is not declared`);
      return key;
    },
    fingerprintKey,
  });
}

export function assertCredentialKeyringReady(env: NodeJS.ProcessEnv = process.env): void {
  loadCredentialKeyring(env);
}
