import { NextResponse } from "next/server";
import { checkApiHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const result = await checkApiHealth();
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
