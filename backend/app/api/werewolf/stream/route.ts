export const runtime = "nodejs";

import { getUpstashRealtime } from "@/runtime/upstash-realtime";

function sse(payload: unknown, id?: string | number) {
  const prefix = id === undefined ? "" : `id: ${id}\n`;
  return new TextEncoder().encode(`${prefix}data: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const gameId = (url.searchParams.get("gameId") ?? "").trim();
  if (!gameId) return Response.json({ error: "gameId is required" }, { status: 400 });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const events = [
        "ui.werewolf.game_created",
        "ui.werewolf.phase_change",
        "ui.werewolf.turn_start",
        "ui.werewolf.turn_end",
        "ui.werewolf.emotion_update",
        "ui.werewolf.speech_delta",
        "ui.werewolf.speech",
        "ui.werewolf.vote",
        "ui.werewolf.vote_reveal",
        "ui.werewolf.night_action",
        "ui.werewolf.day_announce",
        "ui.werewolf.elimination",
        "ui.werewolf.gm_notice",
        "ui.werewolf.game_over",
      ];
      let unsubscribe: (() => void) | null = null;
      unsubscribe = await getUpstashRealtime()
        .channel(`werewolf:${gameId}`)
        .subscribe({
          events,
          history: { start: "-" as any, end: "+" as any },
          onData: (evt) => {
            controller.enqueue(sse({ event: evt.event, data: (evt.data as any)?.data ?? evt.data }, (evt as any).id));
          },
        });
      const keepAlive = setInterval(() => controller.enqueue(new TextEncoder().encode(": ping\n\n")), 15000);
      const close = () => {
        clearInterval(keepAlive);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // ignore
        }
      };
      if (req.signal.aborted) close();
      req.signal.addEventListener("abort", close, { once: true });
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Encoding": "none",
    },
  });
}
