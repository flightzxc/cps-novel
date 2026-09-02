import { PrismaClient } from "@prisma/client";

import { loadCredentialKeyring } from "../src/lib/credentials/keyring";
import {
  decryptCredentialSecretForWorker,
  fingerprintCredentialSecretForWorker,
} from "../worker/credentials/crypto";

type SupersededCredential = {
  id: string;
  channel_account_id: string;
  encrypted_secret: Uint8Array;
  key_version: number;
  secret_fingerprint: string;
  fingerprint_prefix: string;
};

async function main(): Promise<void> {
  const keyring = loadCredentialKeyring(process.env);
  if (keyring.activeVersion !== 1 || !keyring.declaredVersions.includes(1) || !keyring.declaredVersions.includes(2)) {
    throw new Error("v1_readback_probe_configuration_invalid");
  }

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw<SupersededCredential[]>`
      SELECT id, channel_account_id, encrypted_secret, key_version, secret_fingerprint, fingerprint_prefix
      FROM channel_account_credential
      WHERE status='superseded' AND key_version=1
      ORDER BY updated_at DESC, id
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) throw new Error("v1_superseded_probe_row_missing");
    let secret: string | undefined = decryptCredentialSecretForWorker(
      row.encrypted_secret,
      row.channel_account_id,
      row.id,
      row.key_version,
      process.env,
    );
    try {
      if (!secret) throw new Error("v1_superseded_probe_decrypt_failed");
      const calculatedFingerprint = fingerprintCredentialSecretForWorker(secret, process.env).full;
      if (calculatedFingerprint !== row.secret_fingerprint) {
        throw new Error("fingerprint_key_material_mismatch");
      }
    } finally {
      secret = undefined;
    }
    process.stdout.write(JSON.stringify({
      event: "p0_1_v1_superseded_readback",
      result: "PASS",
      encryptionKeyMaterial: "PASS",
      fingerprintKeyMaterial: "PASS",
      keyVersion: row.key_version,
      fingerprintPrefix: row.fingerprint_prefix.slice(0, 12),
    }) + "\n");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  process.stderr.write("P0_1_V1_SUPERSEDED_READBACK=FAIL\n");
  process.exitCode = 1;
});
