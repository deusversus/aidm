CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "arcs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"stratum" text NOT NULL,
	"dramatic_question" text NOT NULL,
	"shape" text NOT NULL,
	"budget" jsonb NOT NULL,
	"phase" text NOT NULL,
	"payoff_contract" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"canon_weight" text DEFAULT 'full_canon' NOT NULL,
	"parent_id" uuid,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"player_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"premise_contract" jsonb,
	"tier_models" jsonb,
	"arc_override" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "canon_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" text NOT NULL,
	"page_type" text NOT NULL,
	"title" text,
	"content" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"source_url" text,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "compacted_beats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"content" text NOT NULL,
	"is_epoch" boolean DEFAULT false NOT NULL,
	"from_turn" integer NOT NULL,
	"to_turn" integer NOT NULL,
	"position" integer NOT NULL,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "consequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"description" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "critical_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"content" text NOT NULL,
	"category" text NOT NULL,
	"source_memory_id" uuid,
	"demoted_at" timestamp with time zone,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"entity_type" text NOT NULL,
	"block" text DEFAULT '' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"block" text NOT NULL,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "episodic_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"turn_number" integer NOT NULL,
	"player_input" text NOT NULL,
	"narration" text NOT NULL,
	"narrated_fragment" text,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid,
	"turn_number" integer,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"tier" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"content" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"removed_at" timestamp with time zone,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pencil_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"topic" text NOT NULL,
	"direction" text NOT NULL,
	"evidence" text NOT NULL,
	"superseded_by" uuid,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"content" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "players" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rewinds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"rewound_to_turn" integer NOT NULL,
	"tombstoned_count" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"description" text NOT NULL,
	"expected_payoff" text,
	"status" text DEFAULT 'planted' NOT NULL,
	"planted_turn" integer NOT NULL,
	"payoff_window" jsonb,
	"urgency" real DEFAULT 0 NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"resolved_turn" integer,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "semantic_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"category" text NOT NULL,
	"base_heat" real DEFAULT 50 NOT NULL,
	"last_boosted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heat_floor" real DEFAULT 0 NOT NULL,
	"plot_critical" boolean DEFAULT false NOT NULL,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"session_number" integer NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"close_trigger" text,
	"director_memo" text,
	"voice_journal" text,
	"yokoku" text,
	"turn_id" integer NOT NULL,
	"provenance" text NOT NULL,
	"confidence" real NOT NULL,
	"tombstoned_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "state_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"turn_number" integer NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"turn_number" integer NOT NULL,
	"tier" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"player_input" text NOT NULL,
	"conte" jsonb,
	"narration" text,
	"sidecar" jsonb,
	"checkpoints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "arcs" ADD CONSTRAINT "arcs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "arcs" ADD CONSTRAINT "arcs_parent_id_arcs_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."arcs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "compacted_beats" ADD CONSTRAINT "compacted_beats_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "consequences" ADD CONSTRAINT "consequences_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "critical_facts" ADD CONSTRAINT "critical_facts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entities" ADD CONSTRAINT "entities_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "episodic_records" ADD CONSTRAINT "episodic_records_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "overrides" ADD CONSTRAINT "overrides_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pencil_marks" ADD CONSTRAINT "pencil_marks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pencil_marks" ADD CONSTRAINT "pencil_marks_superseded_by_pencil_marks_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."pencil_marks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pins" ADD CONSTRAINT "pins_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "quests" ADD CONSTRAINT "quests_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rewinds" ADD CONSTRAINT "rewinds_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seeds" ADD CONSTRAINT "seeds_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
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
 ALTER TABLE "session_records" ADD CONSTRAINT "session_records_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "state_snapshots" ADD CONSTRAINT "state_snapshots_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
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
CREATE INDEX IF NOT EXISTS "arcs_campaign_idx" ON "arcs" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_player_idx" ON "campaigns" USING btree ("player_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canon_chunks_profile_idx" ON "canon_chunks" USING btree ("profile_id","page_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "canon_chunks_embedding_hnsw" ON "canon_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "compacted_beats_campaign_idx" ON "compacted_beats" USING btree ("campaign_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "consequences_campaign_idx" ON "consequences" USING btree ("campaign_id","active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "critical_facts_campaign_idx" ON "critical_facts" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entities_campaign_type_name_uq" ON "entities" USING btree ("campaign_id","entity_type","name") WHERE "entities"."tombstoned_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entity_versions_entity_version_uq" ON "entity_versions" USING btree ("entity_id","version") WHERE "entity_versions"."tombstoned_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "episodic_campaign_turn_uq" ON "episodic_records" USING btree ("campaign_id","turn_number") WHERE "episodic_records"."tombstoned_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_calls_campaign_idx" ON "model_calls" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "overrides_campaign_idx" ON "overrides" USING btree ("campaign_id","active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pencil_marks_campaign_idx" ON "pencil_marks" USING btree ("campaign_id","kind","topic");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pins_campaign_idx" ON "pins" USING btree ("campaign_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quests_campaign_idx" ON "quests" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seeds_campaign_idx" ON "seeds" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "semantic_memories_campaign_idx" ON "semantic_memories" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "semantic_memories_embedding_hnsw" ON "semantic_memories" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_records_campaign_session_uq" ON "session_records" USING btree ("campaign_id","session_number") WHERE "session_records"."tombstoned_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "state_snapshots_campaign_idx" ON "state_snapshots" USING btree ("campaign_id","turn_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "turns_campaign_turn_uq" ON "turns" USING btree ("campaign_id","turn_number");