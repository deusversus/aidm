CREATE TABLE IF NOT EXISTS "context_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"block_type" text NOT NULL,
	"entity_id" uuid,
	"entity_name" text NOT NULL,
	"content" text NOT NULL,
	"continuity_checklist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"first_turn" integer NOT NULL,
	"last_updated_turn" integer NOT NULL,
	"embedding" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "context_blocks" ADD CONSTRAINT "context_blocks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "context_blocks_unique" ON "context_blocks" USING btree ("campaign_id","block_type","entity_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_blocks_campaign_type" ON "context_blocks" USING btree ("campaign_id","block_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_blocks_entity" ON "context_blocks" USING btree ("campaign_id","entity_id");