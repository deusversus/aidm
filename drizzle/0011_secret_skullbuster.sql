ALTER TABLE "seeds" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint
ALTER TABLE "seeds" ADD COLUMN "candidates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "seeds" ADD COLUMN "resolved_by" text;