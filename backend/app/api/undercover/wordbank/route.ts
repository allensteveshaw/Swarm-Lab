export const runtime = "nodejs";

import { getUndercoverWordbank } from "@/game/undercover/service";

export async function GET() {
  return Response.json({ wordbank: getUndercoverWordbank() });
}

