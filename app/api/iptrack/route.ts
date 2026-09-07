import { NextRequest, NextResponse } from "next/server";
import { lookupIp } from "@/lib/ipTracker";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: { ip?: string; apiKey?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { ip, apiKey } = body;
  if (!ip || !ip.trim()) {
    return NextResponse.json({ error: "Enter an IP address to track." }, { status: 400 });
  }
  if (!apiKey || !apiKey.trim()) {
    return NextResponse.json({ error: "Add your IPStack API key first." }, { status: 400 });
  }

  try {
    const result = await lookupIp(ip, apiKey);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "IP lookup failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
