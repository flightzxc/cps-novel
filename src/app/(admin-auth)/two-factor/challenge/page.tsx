import { redirect } from "next/navigation";

import { projectTwoFactorChallenge, type TwoFactorChallengeView } from "@/contracts";
import { hashTwoFactorChallengeToken, TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS } from "@/lib/auth/two-factor";
import type { AdminAuthContext } from "@/lib/auth/types";

import { twoFactorStore } from "../../../api/admin/_lib/auth-deps";
import { AuthCard } from "../../_components/auth-card";
import { AuthLogoutControl } from "../../_components/auth-logout-control";
import {
  ADMIN_LANDING_PATH,
  LOGIN_PATH,
  readActiveContext,
  readTwoFactorChallengeToken,
  safeNextPath,
  TWO_FACTOR_SETUP_PATH,
} from "../../_lib/auth-session";
import { ChallengeForm } from "./_components/challenge-form";

export const dynamic = "force-dynamic";

type SearchParams = { next?: string };

/**
 * Resolves the pending challenge for display (expiry, attempts remaining).
 * Returns `null` for "nothing to show" (no cookie, wrong session/identity,
 * consumed, or expired) — `ChallengeForm` renders that as "expired, resend"
 * rather than a hard error, since it is the ordinary outcome of a 5-minute
 * window elapsing while the operator reaches for their authenticator app.
 */
async function loadChallengeView(
  context: Pick<AdminAuthContext, "identity" | "session">,
  token: string | null,
): Promise<TwoFactorChallengeView | null> {
  if (!token) return null;
  const challenge = await twoFactorStore().findChallengeByTokenHash(hashTwoFactorChallengeToken(token));
  if (
    !challenge
    || challenge.identityId !== context.identity.id
    || challenge.sessionId !== context.session.id
    || challenge.consumedAt
    || challenge.expiresAt.getTime() <= Date.now()
  ) {
    return null;
  }
  return projectTwoFactorChallenge({ challenge, maxAttempts: TWO_FACTOR_CHALLENGE_MAX_ATTEMPTS });
}

export default async function TwoFactorChallengePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { next } = await searchParams;
  const context = await readActiveContext();
  if (!context) redirect(LOGIN_PATH);
  if (!context.identity.twoFactorEnabled) redirect(TWO_FACTOR_SETUP_PATH);
  if (context.twoFactorCompleted) redirect(safeNextPath(next) ?? ADMIN_LANDING_PATH);

  const view = await loadChallengeView(context, await readTwoFactorChallengeToken());

  return (
    <div className="flex w-full max-w-md flex-col items-center">
      <AuthCard title="双重验证" description="输入身份验证器应用中的 6 位验证码，或使用一次性恢复码">
        <ChallengeForm view={view} next={safeNextPath(next)} />
      </AuthCard>
      <div className="mt-3">
        <AuthLogoutControl />
      </div>
    </div>
  );
}
