import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { readPlayerTheme, setPlayerTheme } from "@/lib/db/helpers";
import { players } from "@/lib/db/schema";
import { THEMES } from "@/lib/theme";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The reading theme (M3R4 B5). Player-scoped, so it does NOT ride the campaign
 * settings route: nothing here is campaign-owned, there is no ownership check
 * to make beyond "you are you", and no settingsLog entry — this is a machinery
 * preference like the narrator voice, not a contract field.
 *
 * The strict body is the same boundary the campaign settings route draws: the
 * ONLY writable key is the theme, and only to a value from the enum.
 */

const ThemePatch = z.object({ theme: z.enum(THEMES) }).strict();

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  return NextResponse.json({ theme: await readPlayerTheme(getDb(), user.id) });
}

export async function PATCH(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const body = ThemePatch.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: 'theme must be "dark" or "light"' }, { status: 400 });
  }

  const db = getDb();
  // Same dev safety net as POST /api/sz: the Clerk webhook provisions players
  // in prod, but a local session can predate it and the jsonb write below is an
  // UPDATE — with no row it would report success having written nothing.
  await db
    .insert(players)
    .values({ id: user.id, email: user.email ?? "" })
    .onConflictDoNothing();
  await setPlayerTheme(db, user.id, body.data.theme);

  // Answer with what the record now holds, never with the request body.
  return NextResponse.json({ ok: true, theme: await readPlayerTheme(db, user.id) });
}
