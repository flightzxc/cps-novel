/**
 * Type-only re-export of `@/server/site-settings` view shapes.
 *
 * `tests/ui/admin-secret-boundary.test.tsx` forbids any `"use client"` file
 * from naming an `@/server/**` module, even in a type position. This file
 * has no `"use client"` directive, so it is the correct place to be the
 * *only* module in this route that names `@/server/site-settings`; the
 * Client Component imports the shapes from here instead — the same
 * discipline `novels/_actions.ts` already uses for publish-gate types.
 */
export type { AdminSiteSettingView, SiteSettingMutationResult } from "@/server/site-settings";
