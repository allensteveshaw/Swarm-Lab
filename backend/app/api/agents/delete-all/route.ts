export const runtime = "nodejs";

import { getAgentRuntime } from "@/runtime/agent-runtime";
import { getWorkspaceUIBus } from "@/runtime/ui-bus";

type AgentKind = "system_human" | "system_assistant" | "worker" | "game_ephemeral";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | {
        workspaceId?: string;
        includeKinds?: AgentKind[];
        excludeKinds?: AgentKind[];
      }
    | null;

  const workspaceId = body?.workspaceId?.trim();
  if (!workspaceId) {
    return Response.json({ error: "Missing workspaceId" }, { status: 400 });
  }

  const runtime = getAgentRuntime();
  const result = await runtime.softDeleteAll({
    workspaceId,
    includeKinds: body?.includeKinds ?? ["worker", "game_ephemeral"],
    excludeKinds: body?.excludeKinds ?? ["system_human", "system_assistant"],
  });

  getWorkspaceUIBus().emit(workspaceId, {
    event: "ui.agent.delete_all",
    data: {
      workspaceId,
      deleted: result.deleted,
      cleanedGroups: result.cleanedGroups,
      agentIds: result.agentIds,
      groupIds: result.groupIds,
    },
  });

  return Response.json({ ok: true, ...result });
}

