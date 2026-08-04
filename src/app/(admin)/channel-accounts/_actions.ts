"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import {
  projectChannelAccount,
  projectCredentialMetadata,
  projectCredentialQueuedResult,
  type ChannelAccountView,
  type CredentialMetadataView,
  type CredentialQueuedResultView,
  type ErrorEnvelope,
} from "@/contracts";
import { requireAdminActionAccess } from "@/server/auth/guards";
import {
  addOrReplaceCredential,
  createChannelAccount,
  enqueueCredentialOperation,
  setChannelAccountStatus,
} from "@/server/credentials/service";

import { canonicalOrigin, guardDependencies, readSessionToken } from "../../api/admin/_lib/deps";
import { serviceDependencies } from "../../api/admin/_lib/route";
import { toErrorEnvelope } from "../../api/admin/_lib/respond";

/**
 * Credential mutations run as Server Actions, not Route Handlers.
 *
 * `requireFreshAdminServiceMutation` compares `entryId` by exact string, and the
 * services expect Action ids (`admin.channel_account.disable`). A Route Handler
 * issues the Route id (`admin.api.channel_account.disable`), so routing these
 * through `/api/**` would fail the binding check on every write. Reads, which
 * carry no entry binding, stay Route Handlers.
 */
export type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly envelope: ErrorEnvelope };

async function runAction<T>(
  actionId: `admin.${string}`,
  requestId: string,
  run: (authorization: Awaited<ReturnType<typeof authorize>>) => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    const authorization = await authorize(actionId, requestId);
    const data = await run(authorization);
    revalidatePath("/channel-accounts");
    return { ok: true, data };
  } catch (error) {
    return { ok: false, envelope: toErrorEnvelope(error) };
  }
}

async function authorize(actionId: string, requestId: string) {
  const requestHeaders = await headers();
  const { serviceAuthorization } = await requireAdminActionAccess(
    {
      actionId,
      sessionToken: await readSessionToken(),
      origin: requestHeaders.get("origin"),
      canonicalOrigin: await canonicalOrigin(),
      requestId,
    },
    guardDependencies(),
  );
  if (!serviceAuthorization) {
    const { AdminAccessError } = await import("@/lib/auth/errors");
    throw new AdminAccessError(
      "admin_service_authorization_required",
      403,
      "Action is not bound to a capability",
    );
  }
  return serviceAuthorization;
}

export async function createChannelAccountAction(input: {
  requestId: string;
  channelId: string;
  businessId: string;
  accountName: string;
}): Promise<ActionResult<ChannelAccountView | null>> {
  return runAction("admin.channel_account.create", input.requestId, async (authorization) => {
    const account = await createChannelAccount(
      {
        authorization,
        requestId: input.requestId,
        channelId: input.channelId,
        businessId: input.businessId,
        accountName: input.accountName,
      },
      serviceDependencies(),
    );
    return account ? projectChannelAccount(account) : null;
  });
}

export async function setChannelAccountStatusAction(input: {
  requestId: string;
  channelAccountId: string;
  nextStatus: "active" | "disabled";
  reason: string;
}): Promise<ActionResult<ChannelAccountView | null>> {
  const entryId =
    input.nextStatus === "disabled"
      ? ("admin.channel_account.disable" as const)
      : ("admin.channel_account.enable" as const);
  return runAction(entryId, input.requestId, async (authorization) => {
    const account = await setChannelAccountStatus(
      {
        authorization,
        entryId,
        requestId: input.requestId,
        channelAccountId: input.channelAccountId,
        nextStatus: input.nextStatus,
        reason: input.reason,
      },
      serviceDependencies(),
    );
    return account ? projectChannelAccount(account) : null;
  });
}

export async function replaceCredentialAction(input: {
  requestId: string;
  channelAccountId: string;
  secret: string;
  reason: string;
}): Promise<ActionResult<CredentialMetadataView>> {
  return runAction("admin.credential.replace", input.requestId, async (authorization) => {
    const metadata = await addOrReplaceCredential(
      {
        authorization,
        requestId: input.requestId,
        channelAccountId: input.channelAccountId,
        secret: input.secret,
        reason: input.reason,
      },
      serviceDependencies(),
    );
    // The plaintext argument dies with this call: only redacted metadata is
    // returned, and nothing here writes the secret anywhere else.
    return projectCredentialMetadata(metadata);
  });
}

export async function enqueueCredentialAction(input: {
  requestId: string;
  channelAccountId: string;
  credentialId: string;
  operation: "validate" | "supersede";
  reason?: string;
}): Promise<ActionResult<CredentialQueuedResultView>> {
  const entryId =
    input.operation === "validate"
      ? ("admin.credential.validate" as const)
      : ("admin.credential.supersede" as const);
  return runAction(entryId, input.requestId, async (authorization) => {
    const queued = await enqueueCredentialOperation(
      {
        authorization,
        entryId,
        requestId: input.requestId,
        channelAccountId: input.channelAccountId,
        credentialId: input.credentialId,
        operation: input.operation,
        reason: input.reason,
      },
      serviceDependencies(),
    );
    return projectCredentialQueuedResult(queued);
  });
}
