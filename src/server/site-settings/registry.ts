import { ADMIN_PAGE_ROOTS, type AdminRegistry } from "@/server/auth/registry";

export const ADMIN_SITE_SETTING_ROUTES = Object.freeze([
  {
    id: "admin.api.site_settings",
    path: "/api/admin/site-settings",
    methods: ["GET", "PATCH"],
    capability: "settings:manage",
  },
] as const satisfies AdminRegistry["routes"]);

export const SITE_SETTING_ADMIN_REGISTRY: AdminRegistry = Object.freeze({
  pageRoots: ADMIN_PAGE_ROOTS,
  routes: ADMIN_SITE_SETTING_ROUTES,
  actions: Object.freeze([]),
});
