import { getDb } from "@/lib/db";
import { env } from "@/lib/env";
import { users } from "@/lib/state/schema";
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
  } catch {
    return new Response("Signature verification failed", { status: 400 });
  }

  if (evt.type === "user.created" || evt.type === "user.updated") {
    const clerkUser = evt.data;
    const email = clerkUser.email_addresses?.[0]?.email_address;
    if (!email) {
      return new Response("User has no email address", { status: 400 });
    }
    await getDb()
      .insert(users)
      .values({ id: clerkUser.id, email })
      .onConflictDoUpdate({
        target: users.id,
        // Resurrect soft-deleted users if they re-sign-up with the same Clerk id.
        set: { email, deletedAt: null },
      });
  }

  if (evt.type === "user.deleted") {
    const clerkUser = evt.data;
    if (!clerkUser.id) {
      console.warn("user.deleted event without id", { evt });
      return new Response("ok", { status: 200 });
    }
    // Soft delete per ROADMAP §15.4. A nightly cron hard-deletes after 24h.
    // Campaign cascade-soft-delete lands in M3 when campaigns exist in production.
    await getDb().update(users).set({ deletedAt: new Date() }).where(eq(users.id, clerkUser.id));
  }

  return new Response("ok", { status: 200 });
}
