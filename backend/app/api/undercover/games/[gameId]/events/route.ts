export const runtime = "nodejs";

import { listUndercoverEvents } from "@/game/undercover/service";

export async function GET(_: Request, { params }: { params: Promise<{ gameId: string }> }) {
  try {
    const { gameId } = await params;
    const events = await listUndercoverEvents(gameId);
    return Response.json({ events });
  } catch (e) {
    return Response.json(
      { error: "failed_to_get_events", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

