export const runtime = "nodejs";

import { getUpstashRealtime } from "@/runtime/upstash-realtime";
import { getWorkspaceUIBus } from "@/runtime/ui-bus";

function sseWithId(id: string | number | null | undefined, data: unknown) {
  const prefix =
    typeof id === "string"
      ? `id: ${id}\n`
      : typeof id === "number"
        ? `id: ${id}\n`
        : "";
  return new TextEncoder().encode(`${prefix}data: ${JSON.stringify(data)}\n\n`);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId") ?? "";
  if (!workspaceId) {
    return Response.json({ error: "Missing workspaceId" }, { status: 400 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sendKeepalive = () => controller.enqueue(new TextEncoder().encode(`: ping\n\n`));

      let closed = false;

      // Primary: in-process memory bus — zero-latency, always available
      const unsubscribeMemory = getWorkspaceUIBus().subscribe(workspaceId, (evt) => {
        if (closed) return;
        const payload = { event: evt.event, data: evt.data };
        try {
          controller.enqueue(sseWithId(evt.id, payload));
        } catch {
          // ignore if stream already closed
        }
      });

      // Secondary: Redis stream — replay history on connect for any events missed before this SSE connection opened
      let upstashUnsubscribe: (() => void) | null = null;
      try {
        const channel = getUpstashRealtime().channel(`ui:${workspaceId}`);
        upstashUnsubscribe = await channel.subscribe({
          events: [],
          history: { start: "-" as any, end: "+" as any },
          onData: () => {
            // history replay only — live events come from memory bus above
          },
        });
      } catch {
        // Redis unavailable — memory bus alone is sufficient for single-process deployments
      }

      const keepalive = setInterval(sendKeepalive, 15_000);

      const abortHandler = async () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsubscribeMemory();
        upstashUnsubscribe?.();
        try {
          controller.close();
        } catch {
          // ignore double-close
        }
      };

      if (req.signal.aborted) void abortHandler();
      req.signal.addEventListener("abort", () => void abortHandler(), { once: true });
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
