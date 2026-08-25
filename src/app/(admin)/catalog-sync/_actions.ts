"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import type { ErrorEnvelope } from "@/contracts";
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
 * `listPublishableLocales()` (`@/lib/locale/locale-canonical`) is empty for
 * every locale this round, `"en"` included, so there is no publishable locale
 * this round to justify a choice among. `SITE_LOCALES` does register 15
 * locales, but creation is a prerequisite to publishing, not publishing
 * itself, and expanding past `"en"` is deliberately deferred rather than
 * silently allowed.
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
