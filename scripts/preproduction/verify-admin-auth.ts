import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { verifyAdminPassword } from "../../src/lib/auth/password";
import { decryptTotpSecret } from "../../src/lib/auth/totp-crypto";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function oneLine(path: string): Promise<string> {
  if (!path.startsWith("/")) throw new Error("secret file paths must be absolute");
  const value = (await readFile(path, "utf8")).replace(/[\r\n]+$/, "");
  if (!value || value.includes("\n") || value.includes("\r")) throw new Error("invalid secret file shape");
  return value;
}

async function main() {
  const username = required("PREPROD_ADMIN_USERNAME");
  const password = await oneLine(required("PREPROD_ADMIN_PASSWORD_FILE"));
  const totpKey = await oneLine(required("TOTP_ENCRYPTION_KEY_FILE"));
  const prisma = new PrismaClient();
  try {
    const identity = await prisma.adminIdentity.findUnique({
      where: { username },
      include: { twoFactor: true },
    });
    if (!identity || identity.status !== "active") throw new Error("admin identity is not active");
    if (!verifyAdminPassword(password, identity.passwordHash)) throw new Error("password verification failed");
    if (!identity.twoFactor?.enabled || !identity.twoFactor.encryptedSecret) {
      throw new Error("two-factor enrollment is required");
    }
    decryptTotpSecret(identity.twoFactor.encryptedSecret, totpKey);
    console.log("ADMIN_AUTH_VERIFY=PASS");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error("ADMIN_AUTH_VERIFY=FAIL");
  process.exitCode = 1;
});
