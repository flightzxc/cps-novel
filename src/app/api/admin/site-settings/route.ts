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
      ...(Object.prototype.hasOwnProperty.call(body, "siteName") ? { siteName: body.siteName } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "siteDescription") ? { siteDescription: body.siteDescription } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "homeMetaTitle") ? { homeMetaTitle: body.homeMetaTitle } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "homeMetaDescription") ? { homeMetaDescription: body.homeMetaDescription } : {}),
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
      ...(Object.prototype.hasOwnProperty.call(body, "googleSearchConsoleVerification") ? { googleSearchConsoleVerification: body.googleSearchConsoleVerification } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "footerCopyrightText") ? { footerCopyrightText: body.footerCopyrightText } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "footerDisclaimerText") ? { footerDisclaimerText: body.footerDisclaimerText } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "friendLinks") ? { friendLinks: body.friendLinks } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, "ga4MeasurementId") ? { ga4MeasurementId: body.ga4MeasurementId } : {}),
    };
    return updateAdminSiteSetting(input, serviceDependencies());
  });
}
