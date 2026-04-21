CREATE TABLE IF NOT EXISTS "rule_library_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_slug" text NOT NULL,
	"category" text NOT NULL,
	"axis" text,
	"value_key" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"retrieve_conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rule_library_lookup_key" ON "rule_library_chunks" USING btree ("category","axis","value_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rule_library_category_idx" ON "rule_library_chunks" USING btree ("category");