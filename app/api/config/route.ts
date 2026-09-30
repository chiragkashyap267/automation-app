import { NextResponse } from "next/server";
import { passwordRequired } from "@/lib/auth";
import { providerStatus } from "@/lib/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ...providerStatus(), protected: passwordRequired() });
}
