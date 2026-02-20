export const runtime = "nodejs";

import { TASK_TEMPLATES } from "@/lib/task-templates";

export async function GET() {
  return Response.json({ ok: true, templates: TASK_TEMPLATES });
}

