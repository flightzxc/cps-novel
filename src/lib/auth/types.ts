export type AdminIdentityStatus = "active" | "disabled";

export type AdminIdentity = {
  id: string;
  username: string;
  role: string;
  status: AdminIdentityStatus;
  sessionVersion: number;
  twoFactorEnabled: boolean;
};

export type AdminSessionRecord = {
  id: string;
  tokenHash: string;
  identityId: string;
  sessionVersion: number;
  issuedAt: Date;
  lastSeenAt: Date;
  absoluteExpiresAt: Date;
  twoFactorCompletedAt: Date | null;
  revokedAt: Date | null;
};

export type AdminAuthContext = {
  identity: AdminIdentity;
  session: AdminSessionRecord;
  twoFactorCompleted: boolean;
};

export type TwoFactorState = {
  identityId: string;
  enabled: boolean;
  encryptedSecret: string | null;
  confirmedAt: Date | null;
  pendingEncryptedSecret: string | null;
  pendingExpiresAt: Date | null;
  recoveryCodesRotatedAt: Date | null;
};

export type TwoFactorChallenge = {
  id: string;
  identityId: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  attemptCount: number;
  createdAt: Date;
};

export type RecoveryCodeRecord = {
  id: string;
  identityId: string;
  codeHash: string;
  usedAt: Date | null;
};

export type LoginAttemptRecord = {
  identifierHash: string;
  failureCount: number;
  lockedUntil: Date | null;
  updatedAt: Date;
};
