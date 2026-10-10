import { projectAdminHomepageNavMutationResult } from "@/contracts";
import { replaceHomepageNavSelection } from "@/server/tagging/admin-service";

import { guardMutation, serviceDependencies } from "../../_lib/route";
import { handle } from "../../_lib/respond";
import { homepageNavMutation } from "../../_lib/tagging-route";

export const dynamic = "force-dynamic";

/**
 * v0.5.15 首页题材导航勾选：一次替换整份名单（全站 15 个语种共用一份）。
 * 只有 PUT；读取（面板数据）由 `/categories` 页面服务端直接调用 `listHomepageNavCandidates`，不经 HTTP。
 * 权限 `tag:manage` + 两步验证由 registry 绑定、服务内再次校验；不受分类写入开关约束（见服务函数注释）。
 */
export async function PUT(request: Request) {
  return handle(async () => {
    const guarded = await guardMutation(request);
    const result = await replaceHomepageNavSelection({
      authorization: guarded.authorization,
      entryId: "admin.api.canonical_tag.homepage_nav.write",
      mutation: homepageNavMutation(guarded.body, guarded.requestId),
    }, serviceDependencies());
    return projectAdminHomepageNavMutationResult(result);
  });
}
