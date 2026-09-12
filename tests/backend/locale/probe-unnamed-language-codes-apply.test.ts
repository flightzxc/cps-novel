import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";

import { applyProbeUnnamedLanguageCodes } from "../../../scripts/l10n/probe-unnamed-language-codes";
import { encryptCredentialSecretForWorker } from "../../../worker/credentials/crypto";

/**
 * `施工提示词_Sonnet_L10N_P5_...md` §4.H fix: `applyProbeUnnamedLanguageCodes`'s
 * `catch` branch used to hardcode `languageFields: {}`, discarding a raw
 * response body its own `capturingFetch` wrapper had already captured
 * before the adapter's parser threw — exactly what happened on 20/20 of
 * X-2's real samples (2xx `getchapterinfo` responses with a non-array
 * `data.chapterList`, i.e. `MoboreaderAdapterError("malformed_payload")`).
 *
 * Deliberately in its own file (not `probe-unnamed-language-codes.test.ts`,
 * whose header comment documents a "never touches adapter/credential/
 * network code" property for the dry-run path) — this file exercises the
 * real `createMoboreaderReadAdapter`/credential-decrypt round trip, same
 * conventions as `tests/backend/tasks/moboreader.test.ts`'s "MoboReader
 * catalog handler: adapter error visibility (C-10)" block: a real
 * encrypt/decrypt round trip through temp keyring files, plus a
 * `vi.stubGlobal`-free direct `globalThis.fetch` override (this SUT calls
 * the global `fetch`, not an injectable `fetchImpl`, inside its own
 * `capturingFetch` wrapper — see the source file's header comment on why).
 */

const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const CHANNEL_APP_ID = "55555555-5555-4555-8555-555555555555";
const CREDENTIAL_ID = "66666666-6666-4666-8666-666666666666";

function credentialKeyring(): { env: NodeJS.ProcessEnv; cleanup(): void } {
  const directory = mkdtempSync(path.join(tmpdir(), "cps-novel-l10n-probe-keys-"));
  const v1 = path.join(directory, "v1");
  const fingerprint = path.join(directory, "fingerprint");
  writeFileSync(v1, randomBytes(32).toString("base64"), { mode: 0o600 });
  writeFileSync(fingerprint, randomBytes(32).toString("base64"), { mode: 0o600 });
  return {
    env: {
      NODE_ENV: "test",
      CHANNEL_CREDENTIAL_ACTIVE_KEY_VERSION: "1",
      CHANNEL_CREDENTIAL_ENCRYPTION_KEY_V1_FILE: v1,
      CHANNEL_CREDENTIAL_FINGERPRINT_KEY_FILE: fingerprint,
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** `decryptCredentialSecretForWorker` (called inside the SUT with no `env` arg) always reads `process.env` — overlay it for the duration of one run, restoring exactly what was there before. */
async function withProcessEnvOverlay<T>(overlay: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(overlay)) previous.set(key, process.env[key]);
  Object.assign(process.env, overlay);
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Minimal Prisma double for exactly the two calls `applyProbeUnnamedLanguageCodes` issues: `novelSourceItem.findMany` (per registered code) and one `$queryRaw` binding lookup. */
function fakeDb(encryptedSecret: Uint8Array): PrismaClient {
  return {
    novelSourceItem: {
      findMany: async (args: { where: { sourceLanguageCode: string } }) => {
        if (args.where.sourceLanguageCode !== "19") return [];
        return [{
          id: "source-1",
          externalBookId: "book-19-x2",
          title: "X-2 Sample Book",
          channelAppId: CHANNEL_APP_ID,
          rawPayload: { agencyId: "agency-1", seriesId: "series-1", projectType: 1 },
        }];
      },
    },
    $queryRaw: async () => [{
      channel_account_id: ACCOUNT_ID,
      credential_id: CREDENTIAL_ID,
      encrypted_secret: encryptedSecret,
      key_version: 1,
    }],
  } as unknown as PrismaClient;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("applyProbeUnnamedLanguageCodes — catch branch keeps the already-captured raw body (§4.H)", () => {
  it("a malformed_payload response (chapterList non-array, currentLanguage present) still surfaces languageFields/topLevelKeys/dataKeys/errorCode/httpStatus, not an empty {}", async () => {
    const keys = credentialKeyring();
    try {
      await withProcessEnvOverlay(keys.env, async () => {
        const encryptedSecret = new Uint8Array(
          encryptCredentialSecretForWorker("bare-token", ACCOUNT_ID, CREDENTIAL_ID, 1),
        );
        const db = fakeDb(encryptedSecret);

        // X-2's exact real-run shape: 2xx, data.chapterList non-array,
        // data.currentLanguage present at the .data level (see the source
        // file's `rawCoordinate`/`parsePreviewChaptersResponse` — the
        // adapter reads both off `responseData(value)`, i.e. `body.data`).
        globalThis.fetch = (async () =>
          new Response(
            JSON.stringify({ code: 0, msg: "success", data: { bookId: "book-19-x2", chapterList: "not-an-array", currentLanguage: "3" } }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as typeof fetch;

        const report = await applyProbeUnnamedLanguageCodes(db, { ...keys.env, FEATURE_L10N_PROBE_APPLY: "true" }, { sampleSize: 1 });

        expect(report.results).toHaveLength(1);
        const [result] = report.results;
        expect(result.code).toBe("19");
        expect(result.currentLanguage).toBeNull(); // the adapter's own parse never got there — it threw first.
        expect(result.error).toBeTruthy();
        expect(result.errorCode).toBe("malformed_payload");
        expect(result.httpStatus).toBeNull(); // MoboreaderAdapterError("malformed_payload", false) carries no status — a 2xx body failed adapter-side validation, not a transport/HTTP failure.
        // The load-bearing assertion: the catch branch must not have
        // discarded the raw body `capturingFetch` already captured.
        expect(result.languageFields).toEqual({ currentLanguage: "3" });
        expect(result.dataKeys.sort()).toEqual(["bookId", "chapterList", "currentLanguage"]);
        expect(result.topLevelKeys.sort()).toEqual(["code", "data", "msg"]);
      });
    } finally {
      keys.cleanup();
    }
  });
});
