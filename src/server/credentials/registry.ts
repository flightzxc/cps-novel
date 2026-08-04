import { ADMIN_PAGE_ROOTS, type AdminRegistry } from "../auth/registry";

const capability = "credential:manage" as const;

const routes = [
    { id: "admin.api.channel_accounts.list", path: "/api/admin/channel-accounts", methods: ["GET"], capability },
    { id: "admin.api.channel_account.create", path: "/api/admin/channel-accounts/create", methods: ["POST"], capability },
    { id: "admin.api.channel_account.disable", path: "/api/admin/channel-accounts/disable", methods: ["POST"], capability },
    { id: "admin.api.channel_account.enable", path: "/api/admin/channel-accounts/enable", methods: ["POST"], capability },
    { id: "admin.api.credential.metadata", path: "/api/admin/credentials/metadata", methods: ["GET"], capability },
    { id: "admin.api.credential.validate", path: "/api/admin/credentials/validate", methods: ["POST"], capability },
    { id: "admin.api.credential.supersede", path: "/api/admin/credentials/supersede", methods: ["POST"], capability },
    { id: "admin.api.credential_task.status", path: "/api/admin/credential-tasks/status", methods: ["GET"], capability },
  ] as const satisfies AdminRegistry["routes"];
const actions = [
  { id: "admin.channel_account.create", capability, mutation: true },
  { id: "admin.channel_account.disable", capability, mutation: true },
  { id: "admin.channel_account.enable", capability, mutation: true },
  { id: "admin.credential.validate", capability, mutation: true },
  { id: "admin.credential.supersede", capability, mutation: true },
] as const satisfies AdminRegistry["actions"];

export const P1_08B_ADMIN_REGISTRY: AdminRegistry = Object.freeze({
  pageRoots: ADMIN_PAGE_ROOTS,
  routes: Object.freeze(routes),
  actions: Object.freeze(actions),
});
