export const runtime = "nodejs";

import { store } from "@/lib/storage";

type Assignment = {
  agentId?: string;
  modelProfileId?: string | null;
};

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | {
        workspaceId?: string;
        assignments?: Assignment[];
      }
    | null;

  const workspaceId = (body?.workspaceId ?? "").trim();
  const assignments = Array.isArray(body?.assignments) ? body!.assignments : [];

  if (!workspaceId) return Response.json({ error: "Missing workspaceId" }, { status: 400 });
  if (assignments.length === 0) {
    return Response.json({ error: "assignments must not be empty" }, { status: 400 });
  }

  const results: Array<{ agentId: string; ok: boolean; error?: string | null }> = [];
  for (const item of assignments) {
    const agentId = (item.agentId ?? "").trim();
    const modelProfileId = (item.modelProfileId ?? null)?.trim() || null;
    if (!agentId) {
      results.push({ agentId: "", ok: false, error: "Missing agentId" });
      continue;
    }
    try {
      await store.setAgentModelProfile({ agentId, workspaceId, modelProfileId });
      results.push({ agentId, ok: true, error: null });
    } catch (e) {
      results.push({ agentId, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return Response.json({
    ok: results.every((r) => r.ok),
    updated: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}

