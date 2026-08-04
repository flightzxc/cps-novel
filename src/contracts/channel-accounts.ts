import type { ChannelAccountStatus } from "@/domain/database-statuses";

/**
 * Account status is the enable/disable axis and it belongs to the account alone.
 *
 * There is no credential-level disable/enable: disabling an account never writes
 * `channel_account_credential.status`. See `CredentialOperation` for the split.
 */
export type ChannelAccountView = {
  readonly channelAccountId: string;
  readonly channelId: string;
  readonly businessId: string;
  readonly accountName: string;
  readonly status: ChannelAccountStatus;
  readonly lastValidatedAt: string | null;
  readonly lastSyncedAt: string | null;
  readonly createdAt: string;
};

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function narrowStatus(value: string): ChannelAccountStatus {
  return value === "disabled" ? "disabled" : "active";
}

/**
 * Field-by-field so that `deletedAt` and `updatedAt` stay server-side, and so a
 * future column added to the row cannot silently reach the browser.
 */
export function projectChannelAccount(input: {
  id: string;
  channelId: string;
  businessId: string;
  accountName: string;
  status: string;
  lastValidatedAt: Date | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
}): ChannelAccountView {
  return Object.freeze({
    channelAccountId: input.id,
    channelId: input.channelId,
    businessId: input.businessId,
    accountName: input.accountName,
    status: narrowStatus(input.status),
    lastValidatedAt: toIso(input.lastValidatedAt),
    lastSyncedAt: toIso(input.lastSyncedAt),
    createdAt: input.createdAt.toISOString(),
  });
}
