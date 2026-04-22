CREATE TABLE IF NOT EXISTS "user_cost_ledger" (
	"user_id" text NOT NULL,
	"day_bucket" text NOT NULL,
	"total_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_cost_ledger_user_id_day_bucket_pk" PRIMARY KEY("user_id","day_bucket")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_rate_counters" (
	"user_id" text NOT NULL,
	"minute_bucket" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_rate_counters_user_id_minute_bucket_pk" PRIMARY KEY("user_id","minute_bucket")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "daily_cost_cap_usd" numeric(10, 2);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_cost_ledger" ADD CONSTRAINT "user_cost_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_rate_counters" ADD CONSTRAINT "user_rate_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_cost_ledger_user_idx" ON "user_cost_ledger" USING btree ("user_id","day_bucket");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_rate_counters_user_idx" ON "user_rate_counters" USING btree ("user_id","minute_bucket");