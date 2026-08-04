import { projectChannelAccount } from "@/contracts";

import { prisma } from "../_lib/deps";
import { handle } from "../_lib/respond";
import { guardRead } from "../_lib/route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(async () => {
    await guardRead(request);
    const accounts = await prisma.channelAccount.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        channelId: true,
        businessId: true,
        accountName: true,
        status: true,
        lastValidatedAt: true,
        lastSyncedAt: true,
        createdAt: true,
      },
    });
    return accounts.map(projectChannelAccount);
  });
}
