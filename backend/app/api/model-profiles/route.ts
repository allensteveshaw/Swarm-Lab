export const runtime = "nodejs";

import { store, type ModelProvider } from "@/lib/storage";

function parseProvider(raw: unknown): ModelProvider | null {
  if (raw === "glm" || raw === "openrouter" || raw === "openai_compatible") return raw;
  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = (url.searchParams.get("workspaceId") ?? "").trim();
  if (!workspaceId) {
    return Response.json({ error: "Missing workspaceId" }, { status: 400 });
  }

  const profiles = await store.listModelProfiles({ workspaceId });
  return Response.json({
    profiles: profiles.map(({ apiKey: _apiKey, ...rest }) => rest),
  });
}

export async function POST(req: Request) {
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
  const name = (body?.name ?? "").trim();
  const model = (body?.model ?? "").trim();
  const provider = parseProvider(body?.provider);

  if (!workspaceId) return Response.json({ error: "Missing workspaceId" }, { status: 400 });
  if (!name) return Response.json({ error: "Missing name" }, { status: 400 });
  if (!provider) return Response.json({ error: "Invalid provider" }, { status: 400 });
  if (!model) return Response.json({ error: "Missing model" }, { status: 400 });

  const created = await store.createModelProfile({
    workspaceId,
    name,
    provider,
    baseUrl: body?.baseUrl ?? null,
    model,
    apiKey: body?.apiKey ?? null,
    headers: body?.headers ?? {},
    isDefault: body?.isDefault ?? false,
  });
  const { apiKey: _apiKey, ...safe } = created;
  return Response.json(safe, { status: 201 });
}
