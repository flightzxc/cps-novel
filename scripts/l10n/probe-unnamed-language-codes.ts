/**
 * L10N P1 evidence-line X probe — samples `novel_source_item` rows for the
 * two unnamed upstream language codes (`19`/`20`, upstream `languageName`
 * is JSON `null` for both, zero paired evidence — see
 * `docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md`) and,
 * only under `--apply`, re-queries the live upstream `getchapterinfo`
 * endpoint for each sampled book to see whether its response carries a
 * language name/field the catalog list endpoint (`getlistpc`) never gave us
 * (`施工提示词_Sonnet_L10N_P1_语言归一与存量重算_2026-09-10.md` §1.G, plan
 * doc "并行证据线 X" §X-1/X-2).
 *
 * Default (no `--apply`): dry-run, DB-only. Reads ≤20
 * `novel_source_item` rows per code, reporting `externalBookId`/`title`/
 * `hasMultiLanguage` (the last read straight off `raw_payload` — the
 * upstream `getlistpc` catalog row already carries this boolean, see
 * `docs/governance/L10N_UPSTREAM_LANGUAGE_EVIDENCE_2026-09-10.md`'s sample
 * dump). Zero upstream HTTP calls — the exported `probeUnnamedLanguageCodes`
 * core function does not import or reference any adapter/credential/network
 * code on the dry-run path, and this file has NO top-level import of either
 * (Opus 复核 NON_BLOCKING d: the previous wording here was wrong).
 * `worker/credentials/crypto` and `src/lib/adapters` are only ever pulled in
 * by a `Promise.all([import(...), import(...)])` **deferred dynamic
 * import**, statically located inside `applyProbeUnnamedLanguageCodes`
 * itself (the `--apply` branch, see below) — not a top-level `import`
 * statement anywhere in this file — so the module graph for the dry-run
 * path never even resolves those modules, let alone calls into them.
 *
 * `--apply`: reuses the exact same binding/capability/credential/rate-limit
 * machinery `worker/handlers/moboreader.ts`'s preview-refresh handler uses
 * (`getchapterinfo` capability, active credential, `moboreaderUpstreamRateGate`
 * singleton) and the existing `fetchPreviewChapters` adapter method
 * (`src/lib/adapters/moboreader.ts`, `currentLanguage` parsing). The parsed
 * adapter result only exposes `currentLanguage`, but this probe is also
 * asked to record "any key containing lang" in the *raw* response — so
 * `--apply` wraps `fetchImpl` to capture the raw JSON body alongside the
 * parsed call, without touching the adapter itself. This capture (and the
 * extraction/key-census below) happens on BOTH the success path and the
 * `catch` branch — X-2's real run hit `malformed_payload` on 20/20 samples
 * (2xx responses the adapter's own validation rejected), and the raw body
 * was captured every time regardless; discarding it in the error branch
 * would throw away exactly the evidence this probe exists to collect (P5
 * §4.H fix). Output is written to `.tmp/l10n-probe/<timestamp>.json`
 * (gitignored, not committed) — never to the repo, never with promo fields
 * (`existingPromo`/upstream codes/URLs are stripped before writing), never
 * with chapter body text or any value from the response body other than
 * `/lang/i`-matching scalars; the top-level/`.data` key census records key
 * NAMES only, never values.
 *
 * P1 does NOT execute `--apply` — see the construction prompt §1.G/§3 and
 * plan doc §X-2 ("复核通过后在 X8 执行 --apply...Fable 派 Sonnet 执行并回报
 * 脱敏结果" — a later, explicitly authorized round).
 *
 * Usage:
 *   npx tsx scripts/l10n/probe-unnamed-language-codes.ts [--sample-size N]
 *   npx tsx scripts/l10n/probe-unnamed-language-codes.ts --apply [--sample-size N]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { Prisma, PrismaClient } from "@prisma/client";

const PROBE_CODES = ["19", "20"] as const;
export const PROBE_DEFAULT_SAMPLE_SIZE = 20;
export const PROBE_MAX_SAMPLE_SIZE = 20;

export type ProbeSampleRow = {
  id: string;
  externalBookId: string;
  title: string;
  channelAppId: string;
  /**
   * Read straight off `raw_payload->>'hasMultiLanguage'` — `null` when the
   * key is absent or not a boolean (defensive; the evidence dump shows it
   * present and boolean on every sampled row, but `raw_payload` is upstream
   * JSON and this script must not assume that holds for every row).
   */
  hasMultiLanguage: boolean | null;
};

export type ProbeCodeSample = {
  code: string;
  sampleSize: number;
  samples: ReadonlyArray<Pick<ProbeSampleRow, "externalBookId" | "title" | "hasMultiLanguage">>;
};

export type ProbeDryRunReport = {
  mode: "dry-run";
  sampleSizePerCode: number;
  upstreamCallCount: 0;
  results: ProbeCodeSample[];
};

/**
 * DB-only sampler shared by dry-run and `--apply` (apply re-uses the same
 * rows, then additionally queries upstream for each). Injectable-db so it
 * is unit-testable against a fake with zero real database/network access.
 */
export type ProbeSourceItemDb = {
  novelSourceItem: {
    findMany(args: {
      where: { sourceLanguageCode: string; deletedAt: null };
      orderBy: { id: "asc" };
      take: number;
      select: {
        id: true;
        externalBookId: true;
        title: true;
        channelAppId: true;
        rawPayload: true;
      };
    }): Promise<
      Array<{
        id: string;
        externalBookId: string;
        title: string;
        channelAppId: string;
        rawPayload: Prisma.JsonValue;
      }>
    >;
  };
};

function readHasMultiLanguage(rawPayload: Prisma.JsonValue): boolean | null {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return null;
  const value = (rawPayload as Record<string, unknown>).hasMultiLanguage;
  return typeof value === "boolean" ? value : null;
}

async function sampleCode(
  db: ProbeSourceItemDb,
  code: string,
  sampleSize: number,
): Promise<{ code: string; rows: ProbeSampleRow[] }> {
  const rows = await db.novelSourceItem.findMany({
    where: { sourceLanguageCode: code, deletedAt: null },
    orderBy: { id: "asc" },
    take: sampleSize,
    select: { id: true, externalBookId: true, title: true, channelAppId: true, rawPayload: true },
  });
  return {
    code,
    rows: rows.map((row) => ({
      id: row.id,
      externalBookId: row.externalBookId,
      title: row.title,
      channelAppId: row.channelAppId,
      hasMultiLanguage: readHasMultiLanguage(row.rawPayload),
    })),
  };
}

/**
 * Dry-run core (also the first phase of `--apply`, see the CLI entrypoint
 * below). Pure DB reads — makes zero upstream HTTP calls under any
 * circumstance; there is nothing in this function that could reach the
 * network even if called with `apply`-shaped intent, because it has no
 * adapter/credential dependency at all.
 */
export async function probeUnnamedLanguageCodes(
  db: ProbeSourceItemDb,
  options: { sampleSize?: number } = {},
): Promise<ProbeDryRunReport> {
  const sampleSize = Math.max(1, Math.min(options.sampleSize ?? PROBE_DEFAULT_SAMPLE_SIZE, PROBE_MAX_SAMPLE_SIZE));
  const results: ProbeCodeSample[] = [];
  for (const code of PROBE_CODES) {
    const { rows } = await sampleCode(db, code, sampleSize);
    results.push({
      code,
      sampleSize: rows.length,
      samples: rows.map(({ externalBookId, title, hasMultiLanguage }) => ({ externalBookId, title, hasMultiLanguage })),
    });
  }
  return { mode: "dry-run", sampleSizePerCode: sampleSize, upstreamCallCount: 0, results };
}

// ---------------------------------------------------------------------------
// --apply path. Not executed in P1 (construction prompt §1.G/§3) — kept
// import-isolated from the dry-run path above so `probeUnnamedLanguageCodes`
// itself never pulls in adapter/credential/network code.
// ---------------------------------------------------------------------------

/** `code` is the upstream `source_language_code` this row was sampled under (`"19"`/`"20"`) — NOT `row.id`. */
type ApplyRow = ProbeSampleRow & { code: string; rawPayload: Prisma.JsonValue };

async function loadApplyRows(prisma: PrismaClient, sampleSize: number): Promise<ApplyRow[]> {
  const rows: ApplyRow[] = [];
  for (const code of PROBE_CODES) {
    const found = await prisma.novelSourceItem.findMany({
      where: { sourceLanguageCode: code, deletedAt: null },
      orderBy: { id: "asc" },
      take: sampleSize,
      select: { id: true, externalBookId: true, title: true, channelAppId: true, rawPayload: true },
    });
    for (const row of found) {
      rows.push({ ...row, code, hasMultiLanguage: readHasMultiLanguage(row.rawPayload) });
    }
  }
  return rows;
}

type ApplyBindingRow = {
  channelAccountId: string;
  credentialId: string;
  encryptedSecret: Uint8Array;
  keyVersion: number;
};

/** Mirrors `worker/handlers/moboreader.ts`'s preview-refresh binding query, narrowed to the `getchapterinfo` capability only (this probe never calls `getlistpc`/`getbydataid`). */
async function loadApplyBinding(prisma: PrismaClient, channelAppId: string): Promise<ApplyBindingRow> {
  const rows = await prisma.$queryRaw<
    Array<{ channel_account_id: string; credential_id: string; encrypted_secret: Uint8Array; key_version: number }>
  >(Prisma.sql`
    SELECT account.id AS channel_account_id, credential.id AS credential_id,
           credential.encrypted_secret, credential.key_version
    FROM channel_app ca
    JOIN channel c ON c.id = ca.channel_id AND c.status = 'active'
    JOIN channel_account account ON account.channel_id = c.id
      AND account.status = 'active' AND account.deleted_at IS NULL
    JOIN channel_account_credential credential ON credential.channel_account_id = account.id
      AND credential.status = 'active'
      AND (credential.expires_at IS NULL OR credential.expires_at > now())
    JOIN channel_capability capability ON capability.channel_app_id = ca.id
      AND capability.capability_key = 'getchapterinfo' AND capability.status = 'enabled'
      AND capability.side_effecting = false
    WHERE ca.id = ${channelAppId}::uuid AND ca.status = 'active'
    ORDER BY credential.created_at DESC
    LIMIT 2
  `);
  if (rows.length !== 1) {
    throw new Error(rows.length === 0 ? "probe_binding_unavailable" : "probe_credential_ambiguous");
  }
  return {
    channelAccountId: rows[0].channel_account_id,
    credentialId: rows[0].credential_id,
    encryptedSecret: rows[0].encrypted_secret,
    keyVersion: rows[0].key_version,
  };
}

function rawCoordinate(rawPayload: Prisma.JsonValue): { agencyId: string | null; seriesId: string | null; projectType: number | null } {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return { agencyId: null, seriesId: null, projectType: null };
  }
  const row = rawPayload as Record<string, unknown>;
  return {
    agencyId: typeof row.agencyId === "string" || typeof row.agencyId === "number" ? String(row.agencyId) : null,
    seriesId: typeof row.seriesId === "string" || typeof row.seriesId === "number" ? String(row.seriesId) : null,
    projectType: typeof row.projectType === "number" ? row.projectType : null,
  };
}

/**
 * Redaction applied to whatever raw JSON the upstream `getchapterinfo`
 * response carries before it is written to `.tmp/`: strips chapter body
 * text and anything that looks like a promo field, keeps only
 * `currentLanguage` and any other key whose name contains "lang"
 * (case-insensitive) — exactly the evidence this probe exists to collect.
 * Exported (not just module-private) so
 * `tests/backend/locale/probe-unnamed-language-codes.test.ts` can pin its
 * exact extraction behavior against the X-2 real-run shape without going
 * through the full credential/fetch/adapter round trip for every case.
 */
export function extractLanguageFields(rawResponse: unknown): Record<string, unknown> {
  if (!rawResponse || typeof rawResponse !== "object" || Array.isArray(rawResponse)) return {};
  const data = (rawResponse as { data?: unknown }).data;
  const source = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : (rawResponse as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (/lang/i.test(key) && (typeof value === "string" || typeof value === "number" || value === null)) {
      out[key] = value;
    }
  }
  return out;
}

/** Key NAMES only (never values) of a plain-object-shaped value — `null`/array/non-object all extract as `[]`. */
function extractKeyNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>);
}

/**
 * Diagnostic-only key-name census (never values — no promo/body leakage),
 * added per `施工提示词_Sonnet_L10N_P5_...md` §4.H: the raw response's own
 * top-level key set, so a future probe run can see "what shape did this
 * envelope actually have" even when none of its keys happen to match
 * `extractLanguageFields`'s `/lang/i` filter.
 */
function extractTopLevelKeyNames(rawResponse: unknown): string[] {
  return extractKeyNames(rawResponse);
}

/** Same, for the raw response's `.data` object (if any) — the object `extractLanguageFields` actually scans when present. */
function extractDataKeyNames(rawResponse: unknown): string[] {
  if (!rawResponse || typeof rawResponse !== "object" || Array.isArray(rawResponse)) return [];
  return extractKeyNames((rawResponse as { data?: unknown }).data);
}

export type ProbeApplyResultRow = {
  code: string;
  externalBookId: string;
  currentLanguage: string | null;
  languageFields: Record<string, unknown>;
  /** Key names only (§4.H) — the raw response envelope's own top-level keys, populated on both the success and failure path whenever a raw body was actually captured. */
  topLevelKeys: string[];
  /** Key names only (§4.H) — the raw response's `.data` object's keys, same population rule. */
  dataKeys: string[];
  error: string | null;
  /** `MoboreaderAdapterError.code` when the failure came from the adapter's own typed error (e.g. `"malformed_payload"`); `null` on success or a non-adapter throw. */
  errorCode: string | null;
  /** `MoboreaderAdapterError.status` (HTTP status) when the adapter captured one; `null` otherwise. */
  httpStatus: number | null;
};

/**
 * Executes the live `--apply` round. Requires `FEATURE_L10N_PROBE_APPLY=true`
 * in the environment — the same "explicit env owner-gate" pattern
 * `scripts/one-book-promo-claim-smoke.ts` uses (`SMOKE_OWNER_GATE`) — so
 * this cannot fire by accident from a CI run or a stray `--apply` typo.
 */
export async function applyProbeUnnamedLanguageCodes(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv,
  options: { sampleSize?: number } = {},
): Promise<{ generatedAt: string; sampleSizePerCode: number; results: ProbeApplyResultRow[] }> {
  if (env.FEATURE_L10N_PROBE_APPLY !== "true") {
    throw new Error("l10n_probe_apply_owner_gate_missing (set FEATURE_L10N_PROBE_APPLY=true to run --apply)");
  }
  const sampleSize = Math.max(1, Math.min(options.sampleSize ?? PROBE_DEFAULT_SAMPLE_SIZE, PROBE_MAX_SAMPLE_SIZE));
  const rows = await loadApplyRows(prisma, sampleSize);

  // Deferred imports: only pulled in on the `--apply` path, keeping the
  // dry-run path free of any adapter/credential/network module.
  const [{ createMoboreaderReadAdapter, moboreaderUpstreamRateGate, MoboreaderAdapterError }, { decryptCredentialSecretForWorker }] =
    await Promise.all([import("../../src/lib/adapters"), import("../../worker/credentials/crypto")]);

  const results: ProbeApplyResultRow[] = [];
  const bindingCache = new Map<string, ApplyBindingRow>();
  const tokenCache = new Map<string, string>();

  for (const row of rows) {
    // Hoisted above the `try` (not declared inside it) — §4.H fix: the
    // whole point of capturing the raw response is to keep it available to
    // the `catch` branch below, which is exactly the branch X-2's real run
    // hit on every one of its 20/20 samples (`malformed_payload` — see this
    // function's own header). A `let` declared inside `try { ... }` would
    // be out of scope in `catch`, silently forcing the old "discard
    // whatever was captured" bug back the moment anyone touched this code.
    let capturedRaw: unknown = null;
    try {
      const binding = bindingCache.get(row.channelAppId) ?? (await loadApplyBinding(prisma, row.channelAppId));
      bindingCache.set(row.channelAppId, binding);
      const token =
        tokenCache.get(binding.credentialId) ??
        decryptCredentialSecretForWorker(binding.encryptedSecret, binding.channelAccountId, binding.credentialId, binding.keyVersion);
      tokenCache.set(binding.credentialId, token);

      const { agencyId, seriesId, projectType } = rawCoordinate(row.rawPayload);
      if (!agencyId || !seriesId || projectType === null) {
        results.push({
          code: row.code,
          externalBookId: row.externalBookId,
          currentLanguage: null,
          languageFields: {},
          topLevelKeys: [],
          dataKeys: [],
          error: "coordinate_missing",
          errorCode: null,
          httpStatus: null,
        });
        continue;
      }

      const capturingFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        const clone = response.clone();
        clone
          .json()
          .then((json) => {
            capturedRaw = json;
          })
          .catch(() => {
            /* non-JSON body — nothing to capture */
          });
        return response;
      };

      const adapter = createMoboreaderReadAdapter({ fetchImpl: capturingFetch, rateGate: moboreaderUpstreamRateGate, maxAttempts: 1 });
      const parsed = await adapter.fetchPreviewChapters({ agencyId, seriesId, projectType, language: row.code }, token);
      results.push({
        code: row.code,
        externalBookId: row.externalBookId,
        currentLanguage: parsed.currentLanguage,
        languageFields: extractLanguageFields(capturedRaw),
        topLevelKeys: extractTopLevelKeyNames(capturedRaw),
        dataKeys: extractDataKeyNames(capturedRaw),
        error: null,
        errorCode: null,
        httpStatus: null,
      });
    } catch (error) {
      // §4.H fix: previously hardcoded `languageFields: {}` here, discarding
      // `capturedRaw` even when the adapter's own `capturingFetch` wrapper
      // had already captured a full raw body before the adapter's parser
      // threw (X-2's real run: 20/20 samples were 2xx responses that failed
      // adapter-side validation, not transport failures — the raw body was
      // sitting right there every single time). Extract from it exactly
      // like the success path does; `extractLanguageFields`/
      // `extractTopLevelKeyNames`/`extractDataKeyNames` all degrade to
      // empty output on `null` input, so this is safe even when the error
      // happened before any body was ever captured (a real transport
      // failure, timeout, or non-JSON body).
      const adapterError = error instanceof MoboreaderAdapterError ? error : null;
      results.push({
        code: row.code,
        externalBookId: row.externalBookId,
        currentLanguage: null,
        languageFields: extractLanguageFields(capturedRaw),
        topLevelKeys: extractTopLevelKeyNames(capturedRaw),
        dataKeys: extractDataKeyNames(capturedRaw),
        error: error instanceof Error ? error.message : String(error),
        errorCode: adapterError?.code ?? null,
        httpStatus: adapterError?.status ?? null,
      });
    }
  }

  return { generatedAt: new Date().toISOString(), sampleSizePerCode: sampleSize, results };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const sampleSizeArg = arg("--sample-size");
  const sampleSize = sampleSizeArg ? Number(sampleSizeArg) : undefined;
  const prisma = new PrismaClient();
  try {
    const dryRunReport = await probeUnnamedLanguageCodes(prisma, { sampleSize });
    if (!apply) {
      console.log(JSON.stringify(dryRunReport, null, 2));
      return;
    }
    const applyReport = await applyProbeUnnamedLanguageCodes(prisma, process.env, { sampleSize });
    const outDir = path.resolve(process.cwd(), ".tmp/l10n-probe");
    mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${applyReport.generatedAt.replace(/[:.]/g, "-")}.json`);
    writeFileSync(outPath, JSON.stringify(applyReport, null, 2), "utf8");
    console.log(`[APPLY] wrote ${applyReport.results.length} rows to ${outPath} (not committed — .tmp/ is gitignored)`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
