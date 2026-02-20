export const runtime = "nodejs";

import { getWerewolfGame } from "@/game/werewolf/service";

export async function GET(_: Request, { params }: { params: Promise<{ gameId: string }> }) {
  try {
    const { gameId } = await params;
    const game = await getWerewolfGame(gameId);
    return Response.json(game);
  } catch (e) {
    return Response.json(
      { error: "failed_to_get_game", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
