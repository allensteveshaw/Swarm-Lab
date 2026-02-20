export const runtime = "nodejs";

import { getUndercoverGame } from "@/game/undercover/service";

export async function GET(_: Request, { params }: { params: Promise<{ gameId: string }> }) {
  try {
    const { gameId } = await params;
    const game = await getUndercoverGame(gameId);
    return Response.json(game);
  } catch (e) {
    return Response.json(
      { error: "failed_to_get_game", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

