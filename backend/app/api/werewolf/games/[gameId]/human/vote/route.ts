export const runtime = "nodejs";

import { submitHumanVote } from "@/game/werewolf/service";

export async function POST(req: Request, { params }: { params: Promise<{ gameId: string }> }) {
  try {
    const { gameId } = await params;
    const body = (await req.json().catch(() => null)) as
      | { voterAgentId?: string; targetAgentId?: string; reason?: string }
      | null;
    const voterAgentId = (body?.voterAgentId ?? "").trim();
    const targetAgentId = (body?.targetAgentId ?? "").trim();
    if (!voterAgentId || !targetAgentId) {
      return Response.json({ error: "voterAgentId and targetAgentId are required" }, { status: 400 });
    }
    const result = await submitHumanVote({
      gameId,
      voterAgentId,
      targetAgentId,
      reason: body?.reason ?? "",
    });
    return Response.json(result);
  } catch (e) {
    return Response.json(
      { error: "failed_to_submit_vote", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
