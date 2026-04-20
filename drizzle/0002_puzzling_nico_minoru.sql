CREATE TABLE IF NOT EXISTS "arc_plan_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"current_arc" text NOT NULL,
	"arc_phase" text NOT NULL,
	"arc_mode" text NOT NULL,
	"planned_beats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tension_level" numeric(3, 2) DEFAULT '0.30' NOT NULL,
	"set_at_turn" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "director_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"content" text NOT NULL,
	"scope" text DEFAULT 'session' NOT NULL,
	"created_at_turn" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "factions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "foreshadowing_seeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'PLANTED' NOT NULL,
	"payoff_window_min" integer NOT NULL,
	"payoff_window_max" integer NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflicts_with" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"planted_turn" integer NOT NULL,
	"resolved_turn" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_turn" integer NOT NULL,
	"last_seen_turn" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "npcs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'acquaintance' NOT NULL,
	"personality" text DEFAULT '' NOT NULL,
	"goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secrets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"faction" text,
	"visual_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"knowledge_topics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"power_tier" text DEFAULT 'T10' NOT NULL,
	"ensemble_archetype" text,
	"first_seen_turn" integer NOT NULL,
	"last_seen_turn" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relationship_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"npc_id" uuid NOT NULL,
	"milestone_type" text NOT NULL,
	"evidence" text NOT NULL,
	"turn_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "semantic_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"heat" integer DEFAULT 50 NOT NULL,
	"turn_number" integer NOT NULL,
	"embedding" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spotlight_debt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"npc_id" uuid NOT NULL,
	"debt" integer DEFAULT 0 NOT NULL,
	"updated_at_turn" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "voice_patterns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"turn_observed" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "arc_plan_history" ADD CONSTRAINT "arc_plan_history_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "director_notes" ADD CONSTRAINT "director_notes_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "factions" ADD CONSTRAINT "factions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "foreshadowing_seeds" ADD CONSTRAINT "foreshadowing_seeds_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "locations" ADD CONSTRAINT "locations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "npcs" ADD CONSTRAINT "npcs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relationship_events" ADD CONSTRAINT "relationship_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "relationship_events" ADD CONSTRAINT "relationship_events_npc_id_npcs_id_fk" FOREIGN KEY ("npc_id") REFERENCES "public"."npcs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "semantic_memories" ADD CONSTRAINT "semantic_memories_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "spotlight_debt" ADD CONSTRAINT "spotlight_debt_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "spotlight_debt" ADD CONSTRAINT "spotlight_debt_npc_id_npcs_id_fk" FOREIGN KEY ("npc_id") REFERENCES "public"."npcs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "voice_patterns" ADD CONSTRAINT "voice_patterns_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "arc_plan_history_campaign_idx" ON "arc_plan_history" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "arc_plan_history_latest_idx" ON "arc_plan_history" USING btree ("campaign_id","set_at_turn");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "director_notes_campaign_idx" ON "director_notes" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "factions_campaign_name_key" ON "factions" USING btree ("campaign_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "factions_campaign_idx" ON "factions" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "foreshadowing_seeds_campaign_idx" ON "foreshadowing_seeds" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "foreshadowing_seeds_status_idx" ON "foreshadowing_seeds" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "locations_campaign_name_key" ON "locations" USING btree ("campaign_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "locations_campaign_idx" ON "locations" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "npcs_campaign_name_key" ON "npcs" USING btree ("campaign_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "npcs_campaign_idx" ON "npcs" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relationship_events_campaign_idx" ON "relationship_events" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relationship_events_npc_idx" ON "relationship_events" USING btree ("npc_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "semantic_memories_campaign_idx" ON "semantic_memories" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "semantic_memories_category_idx" ON "semantic_memories" USING btree ("campaign_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "spotlight_debt_campaign_npc_key" ON "spotlight_debt" USING btree ("campaign_id","npc_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spotlight_debt_campaign_idx" ON "spotlight_debt" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "voice_patterns_campaign_idx" ON "voice_patterns" USING btree ("campaign_id");