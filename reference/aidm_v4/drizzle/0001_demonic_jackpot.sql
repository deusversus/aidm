CREATE TABLE IF NOT EXISTS "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"concept" text NOT NULL,
	"power_tier" text NOT NULL,
	"sheet" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"media_type" text NOT NULL,
	"content" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"turn_number" integer NOT NULL,
	"player_message" text NOT NULL,
	"narrative_text" text DEFAULT '' NOT NULL,
	"summary" text,
	"intent" jsonb,
	"outcome" jsonb,
	"prompt_fingerprints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trace_id" text,
	"portrait_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"verdict_kind" text DEFAULT 'continue' NOT NULL,
	"cost_usd" numeric(10, 6),
	"ttft_ms" integer,
	"total_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "profile_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "characters" ADD CONSTRAINT "characters_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "turns" ADD CONSTRAINT "turns_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "characters_campaign_key" ON "characters" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "profiles_slug_key" ON "profiles" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "turns_campaign_turn_key" ON "turns" USING btree ("campaign_id","turn_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "turns_campaign_idx" ON "turns" USING btree ("campaign_id");--> statement-breakpoint
-- Full-text search over narrative prose — the retrieval surface for
-- `recall_scene`. Generated column + GIN index. English config is fine
-- at M1; swap to `simple` if multi-language play surfaces a need.
--
-- NOTE: Drizzle-kit doesn't model tsvector generated columns yet, so
-- this addendum isn't in the snapshot. Future `drizzle-kit generate`
-- runs may re-emit the column as "missing"; ignore those diffs or fold
-- into the next migration by hand. Tracked in the Commit 6 audit.
ALTER TABLE "turns" ADD COLUMN "narrative_tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("narrative_text", ''))) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "turns_narrative_tsv_idx" ON "turns" USING gin ("narrative_tsv");