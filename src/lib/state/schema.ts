import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_email_key").on(t.email)],
);

/**
 * Profile — canonical IP data (Cowboy Bebop, Solo Leveling, etc.). The
 * full Zod shape lives in `src/lib/types/profile.ts`; here we just hold
 * the whole profile as jsonb. Eventually we'll lift hot fields out into
 * columns for querying, but at M1 jsonb + Zod-on-read is fast and right.
 */
export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    mediaType: text("media_type").notNull(),
    /** Full Zod-typed Profile object. Validated on read. */
    content: jsonb("content").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("profiles_slug_key").on(t.slug)],
);

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phase: text("phase", { enum: ["sz", "playing", "archived"] })
      .notNull()
      .default("sz"),
    /**
     * `profile_refs` holds the slugs the campaign draws from. A single
     * slug = single-source adaptation; multiple = hybrid. Read via Zod
     * `Campaign.profile_refs` on load.
     */
    profileRefs: jsonb("profile_refs").notNull().default(sql`'[]'::jsonb`),
    /**
     * Active tonal state — active_dna, active_composition, arc_override,
     * world_state, overrides, hybrid_synthesis_notes, etc. The Zod
     * `Campaign` type defines the full shape; this column stores it
     * whole so we can evolve the shape without migrations mid-arc.
     */
    settings: jsonb("settings").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("campaigns_user_active_idx").on(t.userId).where(sql`${t.deletedAt} IS NULL`)],
);

/**
 * Character — the player's protagonist for a specific campaign. One per
 * campaign for M1. Sheet lives in jsonb because its shape is
 * IP-dependent (stat mapping varies by profile) and evolves mid-play.
 */
export const characters = pgTable(
  "characters",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    concept: text("concept").notNull(),
    powerTier: text("power_tier").notNull(),
    /**
     * Full sheet: stats, abilities, inventory, stat_mapping,
     * current_state. See `get_character_sheet` tool in
     * `src/lib/tools/entities/` for the expected shape.
     */
    sheet: jsonb("sheet").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("characters_campaign_key").on(t.campaignId)],
);

/**
 * Turn — a single exchange between player and KA. Persisted end-to-end
 * for audit, recall (`recall_scene` queries the tsvector index on
 * narrativeText), and cost/latency analysis.
 *
 * `promptFingerprints` captures the SHA-256 of every composed prompt
 * the turn invoked (IntentClassifier, OJ, KA blocks, etc.) so a voice
 * regression can be traced to the exact commit that changed any
 * prompt file.
 */
export const turns = pgTable(
  "turns",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    turnNumber: integer("turn_number").notNull(),
    playerMessage: text("player_message").notNull(),
    narrativeText: text("narrative_text").notNull().default(""),
    /** Short summary, populated by the memory writer post-turn. Null on turns that haven't been summarized yet. */
    summary: text("summary"),
    /** IntentOutput from classifier (jsonb). */
    intent: jsonb("intent"),
    /** OutcomeOutput from OJ (jsonb); null for META/OVERRIDE/WB short-circuits. */
    outcome: jsonb("outcome"),
    /** Map of agent-name → prompt fingerprint (SHA-256). */
    promptFingerprints: jsonb("prompt_fingerprints").notNull().default(sql`'{}'::jsonb`),
    /** Langfuse trace id for this turn. */
    traceId: text("trace_id"),
    /** Portraits detected post-hoc via **Name** bold scan. npc_name → portrait_url. */
    portraitMap: jsonb("portrait_map").notNull().default(sql`'{}'::jsonb`),
    /** Route verdict kind: continue | meta | override | worldbuilder. */
    verdictKind: text("verdict_kind", {
      enum: ["continue", "meta", "override", "worldbuilder"],
    })
      .notNull()
      .default("continue"),
    /** USD cost for the turn, summed across agent calls. */
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    /** Time to first token (KA streaming). Null for non-narrative turns. */
    ttftMs: integer("ttft_ms"),
    /** Total wall-clock from request to end_turn. */
    totalMs: integer("total_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("turns_campaign_turn_key").on(t.campaignId, t.turnNumber),
    index("turns_campaign_idx").on(t.campaignId),
    // Full-text search over narrative prose — the retrieval surface for
    // `recall_scene`. Generated via a raw SQL statement in the migration
    // since Drizzle doesn't yet model tsvector generated columns.
  ],
);
