import {
  projectChannelAccount,
  projectCredentialMetadata,
  projectCredentialOperationAvailability,
  type ChannelAccountView,
  type CredentialMetadataView,
} from "@/contracts";
import { findCapabilityState } from "@/features/admin-ui/capability-view";

import { prisma } from "../../api/admin/_lib/deps";
import { AdminShell } from "../_components/admin-shell";
import { capabilityViews, requireAdminPage, sessionView } from "../_lib/page-guard";
import { ChannelAccountsClient } from "./_components/channel-accounts-client";

export const dynamic = "force-dynamic";

export type ChannelAccountRow = {
  readonly account: ChannelAccountView;
  readonly channelCode: string;
  readonly channelName: string;
  readonly credentials: readonly CredentialMetadataView[];
};

/**
 * Reads only the columns `web_app` is granted. `encrypted_secret` and
 * `secret_fingerprint` are absent from every select here — not merely unused,
 * but ungranted at the database, so a careless addition fails loudly rather than
 * leaking.
 */
async function readRows(): Promise<readonly ChannelAccountRow[]> {
  const accounts = await prisma.channelAccount.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      channelId: true,
      businessId: true,
      accountName: true,
      status: true,
      lastValidatedAt: true,
      lastSyncedAt: true,
      createdAt: true,
      channel: { select: { code: true, name: true } },
      credentials: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          channelAccountId: true,
          credentialType: true,
          status: true,
          expiresAt: true,
          lastValidatedAt: true,
          fingerprintPrefix: true,
        },
      },
    },
  });

  return accounts.map((account) => ({
    account: projectChannelAccount(account),
    channelCode: account.channel.code,
    channelName: account.channel.name,
    credentials: account.credentials.map((credential) =>
      projectCredentialMetadata({
        credentialId: credential.id,
        channelAccountId: credential.channelAccountId,
        credentialType: credential.credentialType,
        status: credential.status,
        expiresAt: credential.expiresAt,
        lastValidatedAt: credential.lastValidatedAt,
        fingerprintPrefix: credential.fingerprintPrefix,
      }),
    ),
  }));
}

export default async function ChannelAccountsPage() {
  const context = await requireAdminPage("/channel-accounts");
  const capabilities = capabilityViews(context);
  const credentialManage = findCapabilityState(capabilities, "credential:manage");
  const availability = projectCredentialOperationAvailability({ credentialManage });

  const [rows, channels] = await Promise.all([
    readRows(),
    prisma.channel.findMany({
      where: { status: "active" },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);

  return (
    <AdminShell
      session={sessionView(context)}
      title="渠道账户"
      description="管理渠道子账号与上游 JWT 凭证。密文永不回显，界面只展示指纹前缀。"
    >
      <ChannelAccountsClient
        rows={rows}
        channels={channels}
        availability={availability}
        credentialManage={credentialManage}
      />
    </AdminShell>
  );
}
