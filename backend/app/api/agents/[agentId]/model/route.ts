export const runtime = "nodejs";

import { store } from "@/lib/storage";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const body = (await req.json().catch(() => null)) as
    | {
        workspaceId?: string;
        modelProfileId?: string | null;
      }
    | null;

  const workspaceId = (body?.workspaceId ?? "").trim();
  if (!workspaceId) return Response.json({ error: "Missing workspaceId" }, { status: 400 });
  if (!agentId?.trim()) return Response.json({ error: "Missing agentId" }, { status: 400 });

  await store.setAgentModelProfile({
    agentId: agentId.trim(),
    workspaceId,
    modelProfileId: (body?.modelProfileId ?? null)?.trim() || null,
  });

  const agent = await store.getAgent({ agentId: agentId.trim() });
  return Response.json({
    ok: true,
    agentId: agent.id,
    workspaceId: agent.workspaceId,
    modelProfileId: agent.modelProfileId,
  });
}
