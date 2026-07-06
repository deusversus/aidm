import { getDb } from "@/lib/db";
import { pingAnthropic } from "@/lib/llm";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function checkDb(): Promise<"ok" | "fail"> {
  try {
    await getDb().execute(sql`SELECT 1`);
    return "ok";
  } catch (err) {
    console.error("[ready] db check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return "fail";
  }
}

export async function GET() {
  // Parallel checks; each has its own timeout. Slowest bounded at ~3s so the
  // Railway healthcheck (30s timeout) stays well within limits.
  const [db, anthropic] = await Promise.all([
    checkDb(),
    pingAnthropic(3000).then((ok) => (ok ? ("ok" as const) : ("fail" as const))),
  ]);
  const checks = { db, anthropic };
  const ok = Object.values(checks).every((v) => v === "ok");
  return NextResponse.json({ status: ok ? "ok" : "degraded", checks }, { status: ok ? 200 : 503 });
}
