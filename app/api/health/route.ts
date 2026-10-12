import { NextResponse } from "next/server";
import { PHASE, featureSummary } from "@/lib/features";

export const dynamic = "force-dynamic";

/** Unauthenticated liveness check. Returns no configuration values or secrets. */
export function GET() {
  return NextResponse.json(
    { status: "ok", phase: PHASE, features: featureSummary() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
