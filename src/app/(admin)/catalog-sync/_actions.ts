"use server";

import { randomUUID } from "node:crypto";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import type { ErrorEnvelope } from "@/contracts";
import { isNovelCatalogSyncEnabled, isNovelCatalogSyncWriteAllowed } from "@/lib/flags";
import {
  MoboreaderTaskInputError,
  createMoboreaderCatalogScanTask,
  type MoboreaderTaskCreationResult,
} from "@/lib/tasks/moboreader";
import { requireAdminActionAccess, requireFreshAdminServiceMutation } from "@/server/auth/guards";
import {
  ContentCreationInputError,
  createContentFromSourceItem,
  type ContentCreationInputErrorCode,
  type CreateContentResult,
} from "@/server/content-creation";

import { canonicalOrigin, guardDependencies, prisma, readSessionToken } from "../../api/admin/_lib/deps";
import { toErrorEnvelope } from "../../api/admin/_lib/respond";

/**
 * P0-S13 content-creation trigger.
 *
 * `createContentFromSourceItem` (`@/server/content-creation`) has no
 * authorization of its own — its module header says so explicitly: "No admin
 * UI, no Server Action wrapper. Nothing under `src/app/**` calls this yet."
 * Everything below is that missing wrapper.
 *
 * Two actions, not one, because the operator must see the plan before
 * anything writes: `dryRunContentCreationAction` never sets `mode: "apply"`;
 * only `applyContentCreationAction` does, and only after its own fresh
 * capability + 2FA + same-origin + rate-limit + idempotent-request-id check —
 * the same `requireAdminActionAccess` → `requireFreshAdminServiceMutation`
 * two-step `src/app/(admin)/channel-accounts/_actions.ts` already uses for
 * credential mutations. Unlike those, `createContentFromSourceItem` takes a
 * plain `actor`, not a guard ticket, so the fresh re-check happens here
 * rather than inside the service (the credential services do it themselves
 * because they live in `src/server/`, the guard's own territory — this
 * service does not, by design; see its module header).
 *
 * Locale is hard-coded to `"en"`, not exposed as a picker. Two independent
 * reasons, both already documented on the service
 * (`src/server/content-creation/service.ts`, "Locale is caller-supplied, not
 * derived"): (1) S7a language normalization is not wired, so nothing here can
 * verify a `NovelSourceItem.sourceLocale` actually maps to whatever an
 * operator might pick — offering a dropdown would invite exactly the
 * wrong-locale-content mistake that module header warns about; (2)
 * `listPublishableLocales()` (`@/lib/locale/locale-canonical`) is currently
 * `["en"]` (U6 / D-7), so there is no second publishable locale this round
 * to justify a picker. `SITE_LOCALES` does register 15 locales, but creation
 * is a prerequisite to publishing, not publishing itself, and expanding past
 * `"en"` is deliberately deferred rather than silently allowed.
 */

const CONTENT_CREATION_LOCALE = "en" as const;

export type ContentCreationActionResult =
  | { readonly ok: true; readonly data: CreateContentResult }
  | { readonly ok: false; readonly kind: "access_denied"; readonly envelope: ErrorEnvelope }
  | {
      readonly ok: false;
      readonly kind: "invalid_input";
      readonly code: ContentCreationInputErrorCode;
    };

async function authorizeAction(actionId: `admin.${string}`, requestId: string) {
  const requestHeaders = await headers();
  return requireAdminActionAccess(
    {
      actionId,
      sessionToken: await readSessionToken(),
      origin: requestHeaders.get("origin"),
      canonicalOrigin: await canonicalOrigin(),
      requestId,
    },
    guardDependencies(),
  );
}

/**
 * Read-only preview. Gated by `content:view` — the same bar `/catalog-sync`
 * already requires to render the source-item list at all, so anyone who can
 * see a row can also see what creating from it would do. Performs zero
 * writes: this always calls the service with `mode: "dry_run"`
 * (`createContentFromSourceItem`'s own default, spelled out here anyway so a
 * future edit cannot flip it by deleting a line).
 */
export async function dryRunContentCreationAction(input: {
  novelSourceItemId: string;
  requestId: string;
}): Promise<ContentCreationActionResult> {
  try {
    const { context } = await authorizeAction("admin.content_creation.dry_run", input.requestId);
    const data = await createContentFromSourceItem(prisma, {
      novelSourceItemId: input.novelSourceItemId,
      locale: CONTENT_CREATION_LOCALE,
      mode: "dry_run",
      actor: { type: "admin", adminId: context.identity.id },
      requestId: input.requestId,
    });
    return { ok: true, data };
  } catch (error) {
    if (error instanceof ContentCreationInputError) {
      return { ok: false, kind: "invalid_input", code: error.code };
    }
    return { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}

/**
 * The real write. Gated by `content:publish` — the closest existing
 * content-mutation capability. `AdminCapability`
 * (`src/lib/auth/capabilities.ts`, Codex-owned) has no dedicated
 * `content:create`, and adding one is outside this task's write scope (that
 * file is not under `src/app/**`); reusing `content:publish` is a deliberate,
 * documented choice — see the delivery notes for the tradeoff, not an
 * oversight to "fix" by loosening it to `content:view`. It carries the same
 * `requiresTwoFactor: true` + `super_admin`-default bar as every other real
 * content mutation, which is the right bar for a call that inserts the first
 * `Novel`/`Article` rows a source item will ever have.
 */
export async function applyContentCreationAction(input: {
  novelSourceItemId: string;
  requestId: string;
}): Promise<ContentCreationActionResult> {
  try {
    const { serviceAuthorization } = await authorizeAction(
      "admin.content_creation.apply",
      input.requestId,
    );
    if (!serviceAuthorization) {
      // Unreachable given this action's own registration (capability is
      // always set — see `src/app/api/admin/_lib/registry.ts`), kept as a
      // fail-closed backstop against a future registration mistake rather
      // than trusting that mistake cannot happen.
      const { AdminAccessError } = await import("@/lib/auth/errors");
      throw new AdminAccessError(
        "admin_service_authorization_required",
        403,
        "Action is not bound to a capability",
      );
    }
    const guards = guardDependencies();
    const context = await requireFreshAdminServiceMutation(serviceAuthorization, "content:publish", {
      identities: guards.identities,
      sessions: guards.sessions,
      entryId: "admin.content_creation.apply",
      requestId: input.requestId,
    });
    const data = await createContentFromSourceItem(prisma, {
      novelSourceItemId: input.novelSourceItemId,
      locale: CONTENT_CREATION_LOCALE,
      mode: "apply",
      actor: { type: "admin", adminId: context.identity.id },
      requestId: input.requestId,
    });
    if (data.outcome === "created") {
      // The source item's own status flipped (`pending` → `linked`) and a
      // brand-new `Novel` now exists for `/novels` to list.
      revalidatePath("/catalog-sync");
      revalidatePath("/novels");
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof ContentCreationInputError) {
      return { ok: false, kind: "invalid_input", code: error.code };
    }
    return { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}

/**
 * PR-C2 catalog-scan trigger.
 *
 * `createMoboreaderCatalogScanTask` (`@/lib/tasks/moboreader`) had zero
 * production callers before this file — see the registration comment in
 * `../../api/admin/_lib/registry.ts` (`ADMIN_CATALOG_SCAN_ACTIONS`) for the
 * full rationale. The short version: unlike the content-creation dry run
 * above, the factory writes a `CatalogScanTask` row in *every* mode, so both
 * actions below are mutations, and only `apply` — the mode that can actually
 * make the worker persist upstream data once `NOVEL_CATALOG_SYNC_ALLOW_WRITE`
 * is also on — goes through the extra `requireFreshAdminServiceMutation`
 * step.
 *
 * `requestToken` is never accepted from the caller. It is the factory's own
 * idempotency key (`CatalogScanTask.requestToken` is `@unique`), so a
 * client-supplied value would let a stale or replayed value collide, or let a
 * caller omit it into a validation error; minting a fresh `randomUUID()` here
 * keeps that key entirely server-controlled. The actual "don't double-create"
 * protection an operator experiences is the factory's own
 * `channelAccountId` + `channelAppId` + `projectType` scope check
 * (`active_conflict`), not requestToken replay — a double submit from this
 * form produces two distinct tokens but still only one live task, because the
 * second call observes the first one still `pending`/`processing`.
 */

export type CatalogScanTriggerInput = {
  readonly channelAccountId: string;
  readonly channelAppId: string;
  readonly pageStart: number;
  readonly pageEnd: number;
  readonly pageSize: number;
  readonly requestId: string;
};

export type CatalogScanOutcome =
  | { readonly outcome: "created"; readonly taskId: string; readonly mode: "dry_run" | "apply" }
  | {
      readonly outcome: "created_disabled";
      readonly taskId: string;
      readonly mode: "dry_run" | "apply";
      /**
       * Live state of both gating flags at creation time, not just the one
       * that happened to block this call — an operator who only just turned
       * on `FEATURE_NOVEL_CATALOG_SYNC` still needs to know
       * `NOVEL_CATALOG_SYNC_ALLOW_WRITE` is a separate switch before an
       * `apply` task will ever leave `disabled`.
       */
      readonly flags: { readonly featureEnabled: boolean; readonly writeAllowed: boolean };
    }
  | { readonly outcome: "duplicate"; readonly taskId: string }
  | { readonly outcome: "active_conflict"; readonly taskId: string };

export type CatalogScanActionResult =
  | { readonly ok: true; readonly data: CatalogScanOutcome }
  | { readonly ok: false; readonly kind: "access_denied"; readonly envelope: ErrorEnvelope }
  | { readonly ok: false; readonly kind: "invalid_input"; readonly code: string };

function classifyCatalogScanResult(
  result: MoboreaderTaskCreationResult,
  mode: "dry_run" | "apply",
): CatalogScanOutcome {
  if (result.status === "duplicate") return { outcome: "duplicate", taskId: result.taskId };
  if (result.status === "active_conflict") return { outcome: "active_conflict", taskId: result.taskId };
  if (result.taskStatus === "pending") return { outcome: "created", taskId: result.taskId, mode };
  return {
    outcome: "created_disabled",
    taskId: result.taskId,
    mode,
    flags: {
      featureEnabled: isNovelCatalogSyncEnabled(),
      writeAllowed: isNovelCatalogSyncWriteAllowed(),
    },
  };
}

/**
 * Shared body for both exported actions below. Not exported itself — the
 * public surface is still two named actions (`dryRunCatalogScanTaskAction`,
 * `applyCatalogScanTaskAction`), each with its own hardcoded `mode` and
 * `actionId`, the same shape P0-S13 uses above. A single runtime-branched
 * action taking `mode` as caller input would mean the capability enforced
 * depended on a value the client controls; two statically-registered action
 * ids means the registry — not this function — is what decides which
 * capability an `apply` request needs.
 */
async function runCatalogScanTrigger(
  actionId: "admin.catalog_scan.dry_run" | "admin.catalog_scan.apply",
  mode: "dry_run" | "apply",
  input: CatalogScanTriggerInput,
): Promise<CatalogScanActionResult> {
  try {
    const { context, serviceAuthorization } = await authorizeAction(actionId, input.requestId);
    let actorId = context.identity.id;

    if (mode === "apply") {
      if (!serviceAuthorization) {
        // Unreachable given this action's own registration (capability is
        // always set — see `ADMIN_CATALOG_SCAN_ACTIONS`), kept as a
        // fail-closed backstop against a future registration mistake, same
        // as `applyContentCreationAction` above.
        const { AdminAccessError } = await import("@/lib/auth/errors");
        throw new AdminAccessError(
          "admin_service_authorization_required",
          403,
          "Action is not bound to a capability",
        );
      }
      const guards = guardDependencies();
      const fresh = await requireFreshAdminServiceMutation(serviceAuthorization, "content:publish", {
        identities: guards.identities,
        sessions: guards.sessions,
        entryId: actionId,
        requestId: input.requestId,
      });
      actorId = fresh.identity.id;
    }

    const result = await createMoboreaderCatalogScanTask(prisma, {
      channelAccountId: input.channelAccountId,
      channelAppId: input.channelAppId,
      pageStart: input.pageStart,
      pageEnd: input.pageEnd,
      pageSize: input.pageSize,
      requestToken: randomUUID(),
      actorId,
      requestId: input.requestId,
      mode,
    });
    return { ok: true, data: classifyCatalogScanResult(result, mode) };
  } catch (error) {
    if (error instanceof MoboreaderTaskInputError) {
      return { ok: false, kind: "invalid_input", code: error.code };
    }
    return { ok: false, kind: "access_denied", envelope: toErrorEnvelope(error) };
  }
}

/**
 * Requests `admin.catalog_scan.dry_run` (`content:view` — the same bar
 * `/catalog-sync` already requires to render). Still a real write (see the
 * module-level comment above), so unlike `dryRunContentCreationAction` this
 * one does not skip same-origin/rate-limit/request-id — the registration
 * (`mutation: true`) is what turns those checks on, not this function.
 */
export async function dryRunCatalogScanTaskAction(
  input: CatalogScanTriggerInput,
): Promise<CatalogScanActionResult> {
  return runCatalogScanTrigger("admin.catalog_scan.dry_run", "dry_run", input);
}

/**
 * Requests `admin.catalog_scan.apply` (`content:publish`) and, once granted a
 * ticket, re-validates freshly via `requireFreshAdminServiceMutation` before
 * calling the factory — the same two-step P0-S13 uses for its real write.
 * Even a successful `apply` call here may still create a `disabled` task if
 * `NOVEL_CATALOG_SYNC_ALLOW_WRITE` is off; that is not an error from this
 * action's point of view (the row exists, exactly as requested), it is
 * `classifyCatalogScanResult` producing `created_disabled` for the UI to
 * explain.
 */
export async function applyCatalogScanTaskAction(
  input: CatalogScanTriggerInput,
): Promise<CatalogScanActionResult> {
  return runCatalogScanTrigger("admin.catalog_scan.apply", "apply", input);
}
