import {
  getAdminSiteSetting,
  updateAdminSiteSetting,
  type UpdateSiteSettingInput,
} from "@/server/site-settings";

import { prisma } from "../_lib/deps";
import { handle } from "../_lib/respond";
import { guardMutation, guardRead, serviceDependencies } from "../_lib/route";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(async () => {
    await guardRead(request);
    return getAdminSiteSetting(prisma);
  });
}

export async function PATCH(request: Request): Promise<Response> {
  return handle(async () => {
    const guarded = await guardMutation(request);
    const body = guarded.body;
    const input: UpdateSiteSettingInput = {
      authorization: guarded.authorization,
      requestId: guarded.requestId,
      expectedUpdatedAt: body.expectedUpdatedAt,
      reason: body.reason,
      ...(Object.prototype.hasOwnProperty.call(body, "defaultOgImage")
        ? { defaultOgImage: body.defaultOgImage }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "indexNowHost")
        ? { indexNowHost: body.indexNowHost }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "indexNowKey")
        ? { indexNowKey: body.indexNowKey }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "indexNowKeyLocation")
        ? { indexNowKeyLocation: body.indexNowKeyLocation }
        : {}),
    };
    return updateAdminSiteSetting(input, serviceDependencies());
  });
}
