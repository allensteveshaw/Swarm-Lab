export const runtime = "nodejs";

import { submitHumanNightAction } from "@/game/werewolf/service";

export async function POST(req: Request, { params }: { params: Promise<{ gameId: string }> }) {
  try {
    const { gameId } = await params;
    const body = (await req.json().catch(() => null)) as
      | { actorAgentId?: string; actionType?: string; targetAgentId?: string | null }
      | null;
    const actorAgentId = (body?.actorAgentId ?? "").trim();
    const actionType = (body?.actionType ?? "").trim();
    if (!actorAgentId || !actionType) {
      return Response.json({ error: "actorAgentId and actionType are required" }, { status: 400 });
    }
    const result = await submitHumanNightAction({
      gameId,
      actorAgentId,
      actionType: actionType as any,
      targetAgentId: body?.targetAgentId ?? null,
    });
    return Response.json(result);
  } catch (e) {
    return Response.json(
      { error: "failed_to_submit_night_action", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
