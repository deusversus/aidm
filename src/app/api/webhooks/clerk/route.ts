import { getDb } from "@/lib/db";
import { players } from "@/lib/db/schema";
import { env } from "@/lib/env";
import type { WebhookEvent } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { Webhook } from "svix";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    return new Response("CLERK_WEBHOOK_SECRET not configured", { status: 500 });
  }

  const headerList = await headers();
  const svixId = headerList.get("svix-id");
  const svixTimestamp = headerList.get("svix-timestamp");
  const svixSignature = headerList.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    console.warn("[clerk-webhook] 400 missing svix headers");
    return new Response("Missing svix headers", { status: 400 });
  }

  const payload = await req.text();
  const wh = new Webhook(secret);
  let evt: WebhookEvent;
  try {
    evt = wh.verify(payload, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as WebhookEvent;
  } catch (err) {
    // Signature-verification failures are often benign (webhook replays,
    // mismatched secrets) but repeated failures are an attack signal —
    // log so ops can grep.
    console.warn("[clerk-webhook] 400 signature verification failed", {
      svixId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response("Signature verification failed", { status: 400 });
  }

  if (evt.type === "user.created" || evt.type === "user.updated") {
    const clerkUser = evt.data;
    const primary =
      clerkUser.email_addresses?.find((e) => e.id === clerkUser.primary_email_address_id) ??
      clerkUser.email_addresses?.[0];
    const email = primary?.email_address;
    if (!email) {
      // Acknowledge, don't 400 — a non-2xx makes svix retry forever for a
      // user who will never have an email (phone/OAuth-only signups).
      console.warn("[clerk-webhook] user without email — acknowledged, not persisted", {
        userId: clerkUser.id,
      });
      return new Response("ok", { status: 200 });
    }
    await getDb()
      .insert(players)
      .values({ id: clerkUser.id, email })
      .onConflictDoUpdate({
        target: players.id,
        // Resurrect soft-deleted players if they re-sign-up with the same Clerk id.
        set: { email, deletedAt: null },
      });
  }

  if (evt.type === "user.deleted") {
    const clerkUser = evt.data;
    if (!clerkUser.id) {
      console.warn("[clerk-webhook] user.deleted event without id");
      return new Response("ok", { status: 200 });
    }
    // Soft delete; campaigns and layer data stay for the compiled-campaign
    // export path until a hard-delete sweep exists.
    await getDb()
      .update(players)
      .set({ deletedAt: new Date() })
      .where(eq(players.id, clerkUser.id));
  }

  return new Response("ok", { status: 200 });
}
