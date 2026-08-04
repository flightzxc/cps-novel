import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AdminErrorCode, ErrorEnvelope } from "@/contracts";
import { errorEnvelopeCopy } from "@/features/admin-ui/error-copy";

const ADMIN_UI_ROOTS = [
  "src/app/(admin)",
  "src/features/admin-ui",
  "src/components/ui",
] as const;

/** Field names that must never appear in an admin view or its data plumbing. */
const FORBIDDEN = [
  "encryptedSecret",
  "encrypted_secret",
  "secretFingerprint",
  "secret_fingerprint",
  "keyVersion",
  "key_version",
  "tokenHash",
  "token_hash",
  "passwordHash",
  "sessionVersion",
  "codeHash",
] as const;

/**
 * Comments are stripped before scanning.
 *
 * The guard is about what the code touches, not what a comment says about it —
 * several of these files legitimately explain *why* `encrypted_secret` is absent,
 * and flagging that prose would push authors to delete the explanation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

async function sources(root: string): Promise<{ file: string; source: string }[]> {
  const directory = path.resolve(process.cwd(), root);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return sources(path.relative(process.cwd(), target));
      return entry.isFile() && /\.tsx?$/.test(entry.name)
        ? [
            {
              file: path.relative(process.cwd(), target),
              source: stripComments(await readFile(target, "utf8")),
            },
          ]
        : [];
    }),
  );
  return nested.flat();
}

describe("admin UI never references credential secret material", () => {
  it("keeps forbidden field names out of every admin source file", async () => {
    const files = (await Promise.all(ADMIN_UI_ROOTS.map(sources))).flat();
    expect(files.length).toBeGreaterThan(0);

    for (const { file, source } of files) {
      for (const field of FORBIDDEN) {
        expect(source, `${file} must not reference ${field}`).not.toContain(field);
      }
    }
  });

  it("exposes the fingerprint only through its prefix", async () => {
    const files = (await Promise.all(ADMIN_UI_ROOTS.map(sources))).flat();
    const mentioning = files.filter(({ source }) => /fingerprint/i.test(source));
    expect(mentioning.length).toBeGreaterThan(0);
    for (const { file, source } of mentioning) {
      // A bare `fingerprint` identifier would be the full HMAC; only the
      // `fingerprintPrefix` form may appear in admin code.
      const bare = source.match(/\bfingerprint(?!Prefix)\w*/gi) ?? [];
      expect(bare, `${file} uses a non-prefix fingerprint reference`).toEqual([]);
    }
  });

  it("never reads a server-authored message off an error", async () => {
    const files = (await Promise.all(ADMIN_UI_ROOTS.map(sources))).flat();
    for (const { file, source } of files) {
      expect(source, `${file} must not read error.message`).not.toMatch(/\berror\.message\b/);
      expect(source, `${file} must not read envelope.message`).not.toMatch(/envelope\.message/);
    }
  });
});

describe("error copy is owned by the frontend", () => {
  const codes: readonly AdminErrorCode[] = [
    "jwt_missing",
    "jwt_invalid",
    "jwt_expired",
    "admin_capability_denied",
    "admin_two_factor_required",
    "admin_route_not_registered",
    "admin_action_not_registered",
    "admin_origin_denied",
    "admin_mutation_request_id_invalid",
    "admin_rate_limited",
    "admin_service_authorization_required",
    "two_factor_failed",
    "two_factor_expired",
    "two_factor_locked",
    "credential_validation_queued",
    "credential_missing",
    "credential_expired",
    "credential_fingerprint_conflict",
    "credential_validation_failed",
    "credential_capability_denied",
    "credential_ambiguous",
    "account_inactive",
  ];

  it("has copy for every stable code", () => {
    for (const code of codes) {
      const text = errorEnvelopeCopy({ ok: false, status: 403, code });
      expect(text, `${code} needs copy`).not.toBe("操作失败，请稍后重试");
    }
  });

  it("refines the two session expiries that share a code", () => {
    const base = { ok: false, status: 401, code: "jwt_expired" } as const satisfies ErrorEnvelope;
    const idle = errorEnvelopeCopy({ ...base, details: { reason: "idle_timeout" } });
    const absolute = errorEnvelopeCopy({ ...base, details: { reason: "absolute_timeout" } });
    expect(idle).not.toBe(absolute);
    expect(absolute).toContain("24");
  });

  it("explains an idempotency conflict rather than saying the id is invalid", () => {
    const text = errorEnvelopeCopy({
      ok: false,
      status: 409,
      code: "admin_mutation_request_id_invalid",
      details: { reason: "idempotency_conflict" },
    });
    expect(text).toContain("不同的提交");
  });

  it("names the capability when the envelope carries one", () => {
    const text = errorEnvelopeCopy({
      ok: false,
      status: 403,
      code: "admin_capability_denied",
      details: { capability: "credential:manage" },
    });
    expect(text).toContain("credential:manage");
  });
});
