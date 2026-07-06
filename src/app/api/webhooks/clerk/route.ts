import { env } from "@/lib/env";
import type { WebhookEvent } from "@clerk/nextjs/server";
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

  // Verify-and-acknowledge only until the C3 schema lands the players table;
  // user upsert / soft-delete return there. Acking now keeps Clerk from
  // retry-spamming while the v5 database doesn't exist yet.
  console.info("[clerk-webhook] verified", { type: evt.type });
  return new Response("ok", { status: 200 });
}
