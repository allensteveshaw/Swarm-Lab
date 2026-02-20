export const runtime = "nodejs";

import { submitHumanSpeech } from "@/game/undercover/service";

export async function POST(req: Request, { params }: { params: Promise<{ gameId: string }> }) {
  try {
    const { gameId } = await params;
    const body = (await req.json().catch(() => null)) as { actorAgentId?: string; text?: string } | null;
    const actorAgentId = (body?.actorAgentId ?? "").trim();
    const text = (body?.text ?? "").trim();
    if (!actorAgentId || !text) {
      return Response.json({ error: "actorAgentId and text are required" }, { status: 400 });
    }
    const result = await submitHumanSpeech({ gameId, actorAgentId, text });
    return Response.json(result);
  } catch (e) {
    return Response.json(
      { error: "failed_to_submit_speech", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

