export const runtime = "nodejs";

import { store, type ModelProvider } from "@/lib/storage";

function parseProvider(raw: unknown): ModelProvider | undefined {
  if (raw === "glm" || raw === "openrouter" || raw === "openai_compatible") return raw;
  return undefined;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ profileId: string }> }
) {
  const { profileId } = await params;
  const body = (await req.json().catch(() => null)) as
    | {
        workspaceId?: string;
        name?: string;
        provider?: string;
        baseUrl?: string | null;
        model?: string;
        apiKey?: string | null;
        headers?: Record<string, string>;
        isDefault?: boolean;
      }
    | null;

  const workspaceId = (body?.workspaceId ?? "").trim();
  if (!workspaceId) return Response.json({ error: "Missing workspaceId" }, { status: 400 });
  if (!profileId?.trim()) return Response.json({ error: "Missing profileId" }, { status: 400 });

  const updated = await store.updateModelProfile({
    id: profileId.trim(),
    workspaceId,
    name: body?.name,
    provider: parseProvider(body?.provider),
    baseUrl: body?.baseUrl,
    model: body?.model,
    apiKey: body?.apiKey,
    headers: body?.headers,
    isDefault: body?.isDefault,
  });
  if (!updated) return Response.json({ error: "Not found" }, { status: 404 });
  const { apiKey: _apiKey, ...safe } = updated;
  return Response.json(safe);
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ profileId: string }> }
) {
  const { profileId } = await params;
  const url = new URL(req.url);
  const workspaceId = (url.searchParams.get("workspaceId") ?? "").trim();
  if (!workspaceId) return Response.json({ error: "Missing workspaceId" }, { status: 400 });
  if (!profileId?.trim()) return Response.json({ error: "Missing profileId" }, { status: 400 });

  await store.deleteModelProfile({ id: profileId.trim(), workspaceId });
  return Response.json({ ok: true });
}
