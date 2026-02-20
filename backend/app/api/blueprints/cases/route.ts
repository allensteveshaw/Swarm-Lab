export const runtime = "nodejs";

import { BLUEPRINT_CASES } from "@/lib/blueprints";

export async function GET() {
  return Response.json({ ok: true, cases: BLUEPRINT_CASES });
}
