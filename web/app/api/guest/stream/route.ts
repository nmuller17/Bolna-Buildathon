// P4: Server-Sent Events for /guest and /staff: every recognizer event, as it arrives.
// On (re)connect, a page first gets the current state with `replay: true` (never spoken again).
import { fromLoopback, snapshot, subscribe, type GuestEvent } from "../bus";

export const runtime = "nodejs";

const HEARTBEAT_MS = 15000;

export async function GET(request: Request) {
  if (!fromLoopback(request)) return Response.json({ error: "Loopback only" }, { status: 403 });
  const encoder = new TextEncoder();
  let stop = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop(); // the page went away
        }
      };
      const send = (event: GuestEvent, replay = false) => write(`data: ${JSON.stringify({ ...event, replay })}\n\n`);

      write("retry: 1000\n\n");
      for (const event of snapshot()) send(event, true);
      const unsubscribe = subscribe((event) => send(event));
      const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
      stop = () => {
        unsubscribe();
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener("abort", () => stop());
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
