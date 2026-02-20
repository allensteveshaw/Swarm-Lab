export const runtime = "nodejs";

import { getAgentRuntime } from "@/runtime/agent-runtime";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = (url.searchParams.get("workspaceId") ?? "").trim();
  if (!workspaceId) {
    return Response.json({ error: "Missing workspaceId" }, { status: 400 });
  }

  const runtime = getAgentRuntime();
  const task = await runtime.getActiveTaskRun(workspaceId);
  return Response.json({ ok: true, task });
}
