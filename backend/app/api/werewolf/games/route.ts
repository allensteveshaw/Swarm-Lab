export const runtime = "nodejs";

import { createWerewolfGame, listWerewolfGames } from "@/game/werewolf/service";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const workspaceId = (url.searchParams.get("workspaceId") ?? "").trim();
    if (!workspaceId) return Response.json({ error: "workspaceId is required" }, { status: 400 });
    const games = await listWerewolfGames(workspaceId);
    return Response.json({ games });
  } catch (e) {
    return Response.json(
      { error: "failed_to_list_games", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as { workspaceId?: string; humanAgentId?: string | null } | null;
    const workspaceId = (body?.workspaceId ?? "").trim();
    if (!workspaceId) return Response.json({ error: "workspaceId is required" }, { status: 400 });
    const result = await createWerewolfGame({ workspaceId, humanAgentId: body?.humanAgentId ?? null });
    return Response.json(result, { status: 201 });
  } catch (e) {
    return Response.json(
      { error: "failed_to_create_game", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
