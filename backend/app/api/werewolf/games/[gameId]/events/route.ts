export const runtime = "nodejs";

import { listWerewolfEvents } from "@/game/werewolf/service";

export async function GET(_: Request, { params }: { params: Promise<{ gameId: string }> }) {
  try {
    const { gameId } = await params;
    const events = await listWerewolfEvents(gameId);
    return Response.json({ events });
  } catch (e) {
    return Response.json(
      { error: "failed_to_list_events", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
