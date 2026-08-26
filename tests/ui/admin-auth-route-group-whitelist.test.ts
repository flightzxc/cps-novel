import { readdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PR-C1b · `src/app/(admin-auth)/` page whitelist.
 *
 * `(admin-auth)` is a deliberate double-blind-spot for the two existing
 * page-registration scans:
 *   - `admin-nav-parity.test.tsx`'s "admin page default-deny registration"
 *     suite only walks `src/app/(admin)` and demands every `page.tsx` call
 *     `requireAdminPage`/`requireContentPage` — a login page cannot call the
 *     guard it exists to satisfy, so `(admin-auth)` is out of scope there by
 *     design (see `(admin-auth)/_lib/auth-session.ts`'s own module docstring).
 *   - `public-reading-no-auth.test.ts` explicitly whitelists
 *     `src/app/(admin-auth)` alongside `src/app/(admin)` and
 *     `src/app/api/admin`, so referencing `@/lib/auth/`, `@/server/auth/`,
 *     `requireAdminSession`, etc. from inside it never trips the "public
 *     reading must stay auth-free" scan either.
 *
 * Put together, nothing currently re-reads the *contents* of this directory:
 * a page dropped in here bypasses both the "every admin page is guarded"
 * check and the "auth code stays out of public reading" check simply by
 * living at this one address. This test is the guard rail for that gap — it
 * pins the exact set of `page.tsx` files this route group is allowed to
 * contain to the three that exist today and have been reviewed (login,
 * 2FA challenge, 2FA setup). Adding, removing, or moving a page here must
 * fail this test and force a deliberate update, rather than silently
 * expanding the blind spot.
 */

const ADMIN_AUTH_GROUP = path.resolve(process.cwd(), "src/app/(admin-auth)");

const EXPECTED_PAGES = ["login/page.tsx", "two-factor/challenge/page.tsx", "two-factor/setup/page.tsx"].sort();

async function pageFiles(directory: string, root: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return pageFiles(target, root);
      if (entry.name !== "page.tsx") return [];
      return [path.relative(root, target).split(path.sep).join("/")];
    }),
  );
  return nested.flat();
}

describe("(admin-auth) page whitelist — closing the dual scan blind spot", () => {
  it("contains exactly the three reviewed entry points, no more, no fewer", async () => {
    const files = (await pageFiles(ADMIN_AUTH_GROUP, ADMIN_AUTH_GROUP)).sort();
    expect(files).toEqual(EXPECTED_PAGES);
  });
});
