ALTER TABLE "semantic_memories" ALTER COLUMN "heat" SET DEFAULT 100;--> statement-breakpoint
ALTER TABLE "semantic_memories" ADD COLUMN "flags" jsonb DEFAULT '{}'::jsonb NOT NULL;