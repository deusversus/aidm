CREATE TABLE IF NOT EXISTS "profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"anilist_id" integer,
	"mal_id" integer,
	"profile" jsonb NOT NULL,
	"scope_class" text,
	"research_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
