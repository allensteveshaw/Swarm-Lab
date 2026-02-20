export const runtime = "nodejs";

import { submitHumanSpeech } from "@/game/werewolf/service";

export async function POST(req: Request, { params }: { params: Promise<{ gameId: string }> }) {
  try {
    const { gameId } = await params;
    const body = (await req.json().catch(() => null)) as
      | { actorAgentId?: string; text?: string; action?: "speak" | "skip"; reason?: string }
      | null;
    const actorAgentId = (body?.actorAgentId ?? "").trim();
    const action = body?.action ?? "speak";
    const text = (body?.text ?? "").trim();
    const reason = (body?.reason ?? "").trim();
    if (!actorAgentId) return Response.json({ error: "actorAgentId is required" }, { status: 400 });
    if (action !== "skip" && !text) return Response.json({ error: "text is required when action=speak" }, { status: 400 });
    const result = await submitHumanSpeech({ gameId, actorAgentId, text, action, reason });
    return Response.json(result);
  } catch (e) {
    return Response.json(
      { error: "failed_to_submit_speech", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
