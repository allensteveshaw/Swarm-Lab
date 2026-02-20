export const runtime = "nodejs";

import { store } from "@/lib/storage";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const taskId = (url.searchParams.get("taskId") ?? "").trim();
  if (!taskId) {
    return Response.json({ error: "Missing taskId" }, { status: 400 });
  }
  const review = await store.getTaskReview({ taskId });
  return Response.json({ ok: true, review });
}

