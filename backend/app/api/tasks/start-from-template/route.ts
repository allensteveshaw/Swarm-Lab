export const runtime = "nodejs";

import { getAgentRuntime } from "@/runtime/agent-runtime";
import { buildTemplateGoal, getTaskTemplate } from "@/lib/task-templates";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | {
        workspaceId?: string;
        groupId?: string;
        ownerAgentId?: string;
        templateId?: string;
        topic?: string;
        overrides?: {
          maxDurationMs?: number;
          maxTurns?: number;
          maxTokenDelta?: number;
        };
      }
    | null;

  const workspaceId = body?.workspaceId?.trim();
  const groupId = body?.groupId?.trim() || undefined;
  const ownerAgentId = body?.ownerAgentId?.trim();
  const template = getTaskTemplate(body?.templateId);

  if (!workspaceId || !ownerAgentId || !template) {
    return Response.json(
      { error: "Missing workspaceId/ownerAgentId/templateId" },
      { status: 400 }
    );
  }

  const goal = buildTemplateGoal(template, body?.topic ?? "");

  const runtime = getAgentRuntime();
  const task = await runtime.startTaskRun({
    workspaceId,
    rootGroupId: groupId,
    ownerAgentId,
    goal,
    maxDurationMs:
      Math.max(1, body?.overrides?.maxDurationMs ?? template.suggestedDurationMin * 60 * 1000),
    maxTurns: Math.max(1, body?.overrides?.maxTurns ?? template.defaultMaxTurns),
    maxTokenDelta: Math.max(1000, body?.overrides?.maxTokenDelta ?? template.defaultMaxTokenDelta),
  });

  return Response.json({ ok: true, task, templateId: template.id, goal });
}

