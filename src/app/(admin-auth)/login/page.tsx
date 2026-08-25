import { redirect } from "next/navigation";

import { AuthCard } from "../_components/auth-card";
import { postAuthDestination, readActiveContext, safeNextPath } from "../_lib/auth-session";
import { LoginForm } from "./_components/login-form";

export const dynamic = "force-dynamic";

type SearchParams = { next?: string };

/**
 * Public login page — intentionally outside `(admin)` / `ADMIN_PAGE_ROOTS`.
 * See `(admin-auth)/_lib/auth-session.ts` for why that is the correct
 * default-deny answer here rather than a registry exemption.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { next } = await searchParams;

  // Already holding a valid session: skip the form and continue wherever
  // that session is supposed to go (2FA setup, 2FA challenge, or straight
  // through to the deep link / landing page).
  const context = await readActiveContext();
  if (context) redirect(postAuthDestination(context, next));

  return (
    <AuthCard title="海外阅读后台" description="使用管理员账号登录">
      <LoginForm next={safeNextPath(next)} />
    </AuthCard>
  );
}
