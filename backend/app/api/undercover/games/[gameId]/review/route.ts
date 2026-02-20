export const runtime = "nodejs";

import { getUndercoverReview } from "@/game/undercover/service";

export async function GET(_: Request, { params }: { params: Promise<{ gameId: string }> }) {
  try {
    const { gameId } = await params;
    const review = await getUndercoverReview(gameId);
    return Response.json(review);
  } catch (e) {
    return Response.json(
      { error: "failed_to_get_review", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

