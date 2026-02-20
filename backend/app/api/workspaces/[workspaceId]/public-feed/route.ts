export const runtime = "nodejs";

import { store } from "@/lib/storage";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await ctx.params;
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? 300);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 300;
  const messages = await store.listWorkspacePublicFeed({ workspaceId, limit });
  return Response.json({ messages });
}

