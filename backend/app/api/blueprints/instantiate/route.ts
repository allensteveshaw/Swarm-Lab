export const runtime = "nodejs";

import { getBlueprintCase } from "@/lib/blueprints";
import { store } from "@/lib/storage";
import { getAgentRuntime } from "@/runtime/agent-runtime";
import { getWorkspaceUIBus } from "@/runtime/ui-bus";

type Body = {
  workspaceId?: string;
  blueprintId?: string;
  locale?: "zh" | "en";
};

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Body | null;
  const workspaceId = (body?.workspaceId ?? "").trim();
  const blueprintId = (body?.blueprintId ?? "").trim();
  const locale = body?.locale === "en" ? "en" : "zh";

  if (!workspaceId || !blueprintId) {
    return Response.json(
      { error: "Missing workspaceId/blueprintId" },
      { status: 400 }
    );
  }

  const blueprint = getBlueprintCase(blueprintId);
  if (!blueprint) {
    return Response.json({ error: "Unknown blueprintId" }, { status: 404 });
  }

  const defaults = await store.ensureWorkspaceDefaults({ workspaceId });
  await store.ensurePresetModelProfiles({ workspaceId });

  const runtime = getAgentRuntime();
  await runtime.bootstrap();

  const createdAgents: Array<{ id: string; role: string; p2pGroupId: string }> = [];

  for (const role of blueprint.roles) {
    const created = await store.createSubAgentWithP2P({
      workspaceId,
      creatorId: defaults.assistantAgentId,
      role: role.role,
      guidance: role.guidance,
      kind: "worker",
      autoRunEnabled: false,
    });
    runtime.ensureRunner(created.agentId);
    createdAgents.push({
      id: created.agentId,
      role: role.role,
      p2pGroupId: created.groupId,
    });

    getWorkspaceUIBus().emit(workspaceId, {
      event: "ui.agent.created",
      data: {
        workspaceId,
        agent: { id: created.agentId, role: role.role, parentId: defaults.assistantAgentId },
      },
    });
  }

  const collaborationMemberIds = [
    defaults.humanAgentId,
    defaults.assistantAgentId,
    ...createdAgents.map((x) => x.id),
  ];

  const collaborationGroup = await store.createGroup({
    workspaceId,
    memberIds: collaborationMemberIds,
    name: `${locale === "zh" ? blueprint.nameZh : blueprint.nameEn} / Case`,
    kind: "chat",
  });

  getWorkspaceUIBus().emit(workspaceId, {
    event: "ui.group.created",
    data: {
      workspaceId,
      group: {
        id: collaborationGroup.id,
        name: collaborationGroup.name,
        memberIds: collaborationMemberIds,
      },
    },
  });

  const topicPrompt = locale === "zh" ? blueprint.topicPromptZh : blueprint.topicPromptEn;
  const goalTemplate = locale === "zh" ? blueprint.goalTemplateZh : blueprint.goalTemplateEn;
  const readyText =
    locale === "zh"
      ? `[Blueprint Ready]\n案例已创建。${topicPrompt}`
      : `[Blueprint Ready]\nCase created. ${topicPrompt}`;
  const kickoffResult = await store.sendMessage({
    groupId: collaborationGroup.id,
    senderId: defaults.assistantAgentId,
    content: readyText,
    contentType: "text",
  });

  getWorkspaceUIBus().emit(workspaceId, {
    event: "ui.message.created",
    data: {
      workspaceId,
      groupId: collaborationGroup.id,
      memberIds: collaborationMemberIds,
      message: {
        id: kickoffResult.id,
        senderId: defaults.assistantAgentId,
        sendTime: kickoffResult.sendTime,
        content: readyText,
        contentType: "text",
      },
    },
  });

  return Response.json({
    ok: true,
    blueprintId: blueprint.id,
    workspaceId,
    groupId: collaborationGroup.id,
    createdAgents,
    awaitingTopic: true,
    topicPrompt,
    goalTemplate,
  });
}
