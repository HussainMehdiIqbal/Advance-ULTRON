import { NextRequest, NextResponse } from "next/server";
import { sendCameraDragEvent, isCameraDragActive } from "@/lib/windowDragControl";

export const runtime = "nodejs";

// Deliberately separate from /api/assistant: turning window-drag mode on
// or off goes through Gemini classification (it's a rare, spoken
// intent), but once the mode is on, every animation-frame pinch update
// needs to reach the OS as fast as possible — routing that through an LLM
// call would make the drag feel laggy. This route does no AI work at all,
// just forwards the coordinate straight to the running PowerShell session.
export async function POST(req: NextRequest) {
  let body: { event?: string; x?: number; y?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { event, x, y } = body;
  if (event !== "start" && event !== "move" && event !== "end") {
    return NextResponse.json({ error: "event must be start, move, or end." }, { status: 400 });
  }
  if (!isCameraDragActive()) {
    // Not an error — the frontend may still be sending a trailing "end"
    // right after voice turned the mode off. Just acknowledge it.
    return NextResponse.json({ active: false });
  }
  if (event !== "end" && (typeof x !== "number" || typeof y !== "number")) {
    return NextResponse.json({ error: "x and y are required for start/move." }, { status: 400 });
  }

  sendCameraDragEvent(event, x ?? 0, y ?? 0);
  return NextResponse.json({ active: true });
}
