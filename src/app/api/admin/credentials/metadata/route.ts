import { projectCredentialMetadata } from "@/contracts";
import { listCredentialMetadata } from "@/server/credentials/service";

import { prisma } from "../../_lib/deps";
import { handle } from "../../_lib/respond";
import { guardRead } from "../../_lib/route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(async () => {
    await guardRead(request);
    const channelAccountId = new URL(request.url).searchParams.get("channelAccountId") ?? "";
    const rows = await listCredentialMetadata(prisma, channelAccountId);
    return rows.map(projectCredentialMetadata);
  });
}
