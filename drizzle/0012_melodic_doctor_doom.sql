ALTER TABLE "critical_facts" ADD COLUMN "demoted_at_turn" integer;--> statement-breakpoint
ALTER TABLE "critical_facts" ADD COLUMN "demotion_undo" jsonb;