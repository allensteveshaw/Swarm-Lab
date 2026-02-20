export const runtime = "nodejs";

import { getAgentRuntime } from "@/runtime/agent-runtime";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | {
        workspaceId?: string;
      }
    | null;

  const workspaceId = body?.workspaceId?.trim();
  if (!workspaceId) {
    return Response.json({ error: "Missing workspaceId" }, { status: 400 });
  }

  const runtime = getAgentRuntime();
  const result = await runtime.stopTaskRun({ workspaceId, reason: "manual" });
  return Response.json({ ok: true, task: result });
}

