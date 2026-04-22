import { setUserDailyCap } from "@/lib/budget";
import { currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/user/cap — user sets (or clears) their own daily cost cap.
 *
 * Body:
 *   { capUsd: number | null }
 *
 * - null → clears the cap (no ceiling; default state)
 * - 0    → legitimate "zero-spend" cap (every turn blocks)
 * - > 0  → positive cap in USD, up to 2 decimal places
 *
 * Authorizes on the Clerk session — the user can only set their OWN
 * cap. There is deliberately no `userId` in the body; the session
 * identity IS the authorization. A separate admin surface (M2+) would
 * add that pathway explicitly.
 */
const Body = z.object({
  capUsd: z.union([z.number().nonnegative().max(1_000_000), z.null()]),
});

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_body", detail: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
  try {
    await setUserDailyCap(user.id, body.capUsd);
    return NextResponse.json({ ok: true, capUsd: body.capUsd });
  } catch (err) {
    return NextResponse.json(
      {
        error: "update_failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
