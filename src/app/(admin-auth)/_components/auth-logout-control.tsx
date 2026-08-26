import { buttonClassName } from "@/components/ui/button";

import { logoutAction } from "../_lib/logout-action";

/**
 * Quiet "sign out" control for the 2FA challenge / setup pages — those two
 * screens sit on a password-grade session that `(admin)` page guards will not
 * let through, so the shell logout in the admin header is unreachable.
 *
 * Bound to the real `logoutAction` (no extra gate). Secondary styling so it
 * does not compete with the primary TOTP / setup buttons.
 */
export function AuthLogoutControl() {
  return (
    <form action={logoutAction} className="flex justify-center">
      <button
        type="submit"
        className={buttonClassName("ghost", "px-2 py-1 text-xs font-medium text-gray-500 hover:text-gray-700")}
      >
        退出登录
      </button>
    </form>
  );
}
