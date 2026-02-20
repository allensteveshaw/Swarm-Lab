export const runtime = "nodejs";

import { store } from "@/lib/storage";
import { getAgentRuntime } from "@/runtime/agent-runtime";
import { getWorkspaceUIBus } from "@/runtime/ui-bus";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const trimmedAgentId = agentId?.trim();
  if (!trimmedAgentId) {
    return Response.json({ error: "Missing agentId" }, { status: 400 });
  }

  const agent = await store.getAgent({ agentId: trimmedAgentId }).catch(() => null);
  if (!agent) {
    return Response.json({ error: "agent not found" }, { status: 404 });
  }
  return Response.json({
    agentId: agent.id,
    workspaceId: agent.workspaceId,
    role: agent.role,
    autoRunEnabled: agent.autoRunEnabled,
    modelProfileId: agent.modelProfileId,
    llmHistory: agent.llmHistory,
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const body = (await req.json().catch(() => null)) as
    | {
        autoRunEnabled?: boolean;
      }
    | null;

  const trimmedAgentId = agentId?.trim();
  if (!trimmedAgentId) {
    return Response.json({ error: "Missing agentId" }, { status: 400 });
  }
  if (typeof body?.autoRunEnabled !== "boolean") {
    return Response.json({ error: "Missing autoRunEnabled boolean" }, { status: 400 });
  }

  const agent = await store.getAgent({ agentId: trimmedAgentId }).catch(() => null);
  if (!agent) {
    return Response.json({ error: "agent not found" }, { status: 404 });
  }
  await store.setAgentAutoRun({
    agentId: trimmedAgentId,
    autoRunEnabled: body.autoRunEnabled,
  });

  getWorkspaceUIBus().emit(agent.workspaceId, {
    event: "ui.agent.autorun.changed",
    data: {
      workspaceId: agent.workspaceId,
      agentId: trimmedAgentId,
      autoRunEnabled: body.autoRunEnabled,
    },
  });

  return Response.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const trimmedAgentId = agentId?.trim();
  if (!trimmedAgentId) {
    return Response.json({ error: "Missing agentId" }, { status: 400 });
  }

  const agent = await store.getAgent({ agentId: trimmedAgentId }).catch(() => null);
  if (!agent) {
    return Response.json({ error: "agent not found" }, { status: 404 });
  }
  if (agent.kind === "system_human" || agent.kind === "system_assistant") {
    return Response.json({ error: "Cannot delete system agent" }, { status: 400 });
  }

  const runtime = getAgentRuntime();
  await runtime.interruptAgents([trimmedAgentId]);
  const result = await store.softDeleteAgentsByIds({
    workspaceId: agent.workspaceId,
    agentIds: [trimmedAgentId],
  });
  await store.softDeleteOrphanGroups({ workspaceId: agent.workspaceId });
  await store.softDeleteRedundantSystemGroups({ workspaceId: agent.workspaceId });

  getWorkspaceUIBus().emit(agent.workspaceId, {
    event: "ui.agent.deleted",
    data: { workspaceId: agent.workspaceId, agentId: trimmedAgentId },
  });

  return Response.json({ ok: true, deleted: result.deleted });
}
