export const runtime = "nodejs";

import { getAgentRuntime } from "@/runtime/agent-runtime";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | {
        workspaceId?: string;
        groupId?: string;
        ownerAgentId?: string;
        goal?: string;
        maxDurationMs?: number;
        maxTurns?: number;
        maxTokenDelta?: number;
      }
    | null;

  const workspaceId = body?.workspaceId?.trim();
  const groupId = body?.groupId?.trim() || undefined;
  const ownerAgentId = body?.ownerAgentId?.trim();
  if (!workspaceId || !ownerAgentId) {
    return Response.json(
      { error: "Missing workspaceId/ownerAgentId" },
      { status: 400 }
    );
  }

  const runtime = getAgentRuntime();
  const active = await runtime.startTaskRun({
    workspaceId,
    rootGroupId: groupId,
    ownerAgentId,
    goal: (body?.goal ?? "").trim() || "完成当前任务并给出总结",
    maxDurationMs: body?.maxDurationMs,
    maxTurns: body?.maxTurns,
    maxTokenDelta: body?.maxTokenDelta,
  });

  return Response.json({ ok: true, task: active });
}
