CREATE TABLE IF NOT EXISTS "heat_boosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"boost" real NOT NULL,
	"turn_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "semantic_memories" ALTER COLUMN "heat_floor" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "semantic_memories" ADD COLUMN "last_boosted_turn" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "heat_boosts" ADD CONSTRAINT "heat_boosts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "heat_boosts" ADD CONSTRAINT "heat_boosts_memory_id_semantic_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."semantic_memories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heat_boosts_campaign_idx" ON "heat_boosts" USING btree ("campaign_id","turn_number");