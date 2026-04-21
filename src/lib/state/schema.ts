import { sql } from "drizzle-orm";
import {
  boolean,
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
    /**
     * Timestamp Chronicler successfully processed this turn. Null = not
     * yet chronicled; non-null = Chronicler's post-turn writes landed.
     * Used as the idempotency guard so a retried Chronicler run (e.g.
     * after a deploy mid-flight) doesn't double-apply non-idempotent
     * writes like `record_relationship_event` or `adjust_spotlight_debt`
     * (which additively shift debt via SQL expression).
     */
    chronicledAt: timestamp("chronicled_at", { withTimezone: true }),
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

/**
 * Context blocks — per-entity living prose summaries that survive across
 * sessions. Each row is "the current document for this entity" — the arc's
 * state in 2-4 paragraphs, a quest's trajectory in a few sentences, an
 * NPC's personality + active goals + recent changes as a distilled bio.
 *
 * Distinct from semantic_memories (fact atoms) and turns (transcripts):
 * context_blocks hold the aggregate story-state for an entity at the
 * current moment. Chronicler updates them when material changes happen;
 * KA reads them at session start as "here's where everything stands"
 * so a 50-turn arc's continuity doesn't require 20 MCP tool calls to
 * reconstruct.
 *
 * Versioning: every update bumps `version`, preserves the old content as
 * of that version count (audit trail is via `updated_at` + trace);
 * `continuity_checklist` is structured flat k:v for discrete facts KA
 * must honor ("alive", "knows_about_X", "loyal_to").
 *
 * `embedding` column stays jsonb-null at M1; M4 embedder backfills so
 * Chronicler can query "blocks related to this scene" instead of
 * blanket-loading all active blocks.
 */
export const contextBlocks = pgTable(
  "context_blocks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    blockType: text("block_type", {
      enum: ["arc", "thread", "quest", "npc", "faction", "location"],
    }).notNull(),
    /**
     * FK into npcs/locations/factions when applicable; null for
     * anonymous arc/thread/quest blocks not backed by a catalog row.
     * No explicit FK at the DB level because `entity_id` crosses three
     * different target tables — enforced via Chronicler write tools.
     */
    entityId: uuid("entity_id"),
    entityName: text("entity_name").notNull(),
    content: text("content").notNull(),
    /**
     * Flat k:v jsonb — discrete, load-bearing facts KA must honor.
     * For NPCs: { "alive": true, "knows_about_X": false, "loyal_to": "Red Dragon" }.
     * For arcs: { "transition_signal_reached": false, "escalation_beat": "2/5" }.
     */
    continuityChecklist: jsonb("continuity_checklist").notNull().default(sql`'{}'::jsonb`),
    status: text("status", { enum: ["active", "closed", "archived"] })
      .notNull()
      .default("active"),
    version: integer("version").notNull().default(1),
    firstTurn: integer("first_turn").notNull(),
    lastUpdatedTurn: integer("last_updated_turn").notNull(),
    /** pgvector-ready. jsonb null at M1 (embedder decision is M4). */
    embedding: jsonb("embedding"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("context_blocks_unique").on(t.campaignId, t.blockType, t.entityName),
    index("context_blocks_campaign_type").on(t.campaignId, t.blockType),
    index("context_blocks_entity").on(t.campaignId, t.entityId),
  ],
);

/**
 * Rule library — narration guidance indexed by (category, axis, value_key).
 *
 * Every DNA axis × value combination, every composition enum value, every
 * power tier, every ensemble archetype has a short prose directive here.
 * At session start KA reads the active bundle for THIS campaign's profile
 * + character — the translation layer between "heroism: 7" (a number) and
 * "here's what heroism=7 means in narrative practice."
 *
 * v3 had this content + table. v4 dropped it early in the rewrite; Block 1
 * renders `session_rule_library_guidance` with an empty fallback until this
 * lands. Without it, the 24 DNA axes become form fields instead of
 * prescriptive pressures — "premise-respectful" drifts toward "generic
 * premium LLM anime prose" over hundreds of turns.
 *
 * Storage is flat + category-keyed at M1. pgvector `embedding` column will
 * be added at M4 when the embedder decision lands (same timing as semantic
 * memory retrieval runtime). At M1, lookup is deterministic via
 * (category, axis, value_key) — no embeddings needed because the caller
 * knows exactly which axis/value they want guidance for.
 */
export const ruleLibraryChunks = pgTable(
  "rule_library_chunks",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /**
     * Human-readable slug — "dna_heroism", "composition_tension_source",
     * "power_tier_T3", "archetype_struggler". Used for display / debug
     * and for the YAML filename → DB mapping by the indexer.
     */
    librarySlug: text("library_slug").notNull(),
    /**
     * Top-level grouping. `dna` / `composition` / `power_tier` / `archetype`
     * / `scale` / `ceremony` / `genre` / `tension` / `op_expression` /
     * `beat_craft` (latter added Phase 7).
     */
    category: text("category").notNull(),
    /**
     * Subgrouping within the category — "heroism", "tension_source", etc.
     * Null for non-axis categories (power_tier has axis=null since the
     * tier IS the value).
     */
    axis: text("axis"),
    /**
     * The specific value being looked up — "7" for a DNA axis integer,
     * "existential" for a composition enum, "T3" for a power tier, etc.
     * Null for aggregate entries (rare).
     */
    valueKey: text("value_key"),
    /** Free-form tags for future filtering / retrieval refinement. */
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
    /** Reserved for v3-style conditional retrieval; mostly {} at M1. */
    retrieveConditions: jsonb("retrieve_conditions").notNull().default(sql`'{}'::jsonb`),
    /** The narration guidance itself. 1-5 sentences of directive prose. */
    content: text("content").notNull(),
    /** Bumped when the YAML content changes (indexer handles this). */
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Canonical lookup key — indexer upserts by this tuple.
    uniqueIndex("rule_library_lookup_key").on(t.category, t.axis, t.valueKey),
    index("rule_library_category_idx").on(t.category),
  ],
);

/**
 * Chronicler-written entity + memory + arc state tables (M1 Commit 7.1).
 *
 * Chronicler runs post-every-turn and writes durable state here:
 *   - NPCs / locations / factions the narration introduced
 *   - Relationship-milestone events (first_trust, first_sacrifice, etc.)
 *   - Semantic-memory facts (categorized + heat-decayed per §9.1)
 *   - Foreshadowing seeds (planted, ratified, retired)
 *   - Voice-pattern observations (Director's journal, accumulated)
 *   - Arc plan history (append-only; latest is current)
 *   - Director notes + spotlight debt per NPC
 *
 * Empty sets from these tables are a valid M1 state — the shape is
 * there so tools can read + write even when the campaign has no
 * history. Content richens as Chronicler runs against real turns.
 */

export const npcs = pgTable(
  "npcs",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    /** Human-readable name as the narration uses it. Unique per campaign. */
    name: text("name").notNull(),
    /** ally | rival | mentor | enemy | neutral | acquaintance | ... */
    role: text("role").notNull().default("acquaintance"),
    /** Core personality in 1-2 sentences, inferred from behavior. */
    personality: text("personality").notNull().default(""),
    /** Known / implied goals. */
    goals: jsonb("goals").notNull().default(sql`'[]'::jsonb`),
    /** Secrets hinted at (hidden allegiances, concealed abilities). */
    secrets: jsonb("secrets").notNull().default(sql`'[]'::jsonb`),
    /** Faction / organization affiliation, if any. */
    faction: text("faction"),
    /** Visual descriptors for M8 portrait generation: hair, outfit, scars, etc. */
    visualTags: jsonb("visual_tags").notNull().default(sql`'[]'::jsonb`),
    /** { topic: "expert|moderate|basic" } — what this NPC knows about. */
    knowledgeTopics: jsonb("knowledge_topics").notNull().default(sql`'{}'::jsonb`),
    /** Power tier inferred from context. T1=godlike, T10=civilian. */
    powerTier: text("power_tier").notNull().default("T10"),
    /** Ensemble role: struggler | heart | skeptic | dependent | equal | observer | rival. */
    ensembleArchetype: text("ensemble_archetype"),
    /**
     * Transient vs catalog NPC (v3-parity Phase 6A). True = flavor
     * character unlikely to recur (the bartender, a passing sailor) —
     * no portrait generation, filtered out of list_known_npcs by default,
     * no relationship-event tracking. False = catalog NPC, persistent
     * across sessions.
     */
    isTransient: boolean("is_transient").notNull().default(false),
    firstSeenTurn: integer("first_seen_turn").notNull(),
    lastSeenTurn: integer("last_seen_turn").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("npcs_campaign_name_key").on(t.campaignId, t.name),
    index("npcs_campaign_idx").on(t.campaignId),
    index("npcs_transient_idx").on(t.campaignId, t.isTransient),
  ],
);

export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Free-form details jsonb: description, notable features, etc. */
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    firstSeenTurn: integer("first_seen_turn").notNull(),
    lastSeenTurn: integer("last_seen_turn").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("locations_campaign_name_key").on(t.campaignId, t.name),
    index("locations_campaign_idx").on(t.campaignId),
  ],
);

export const factions = pgTable(
  "factions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("factions_campaign_name_key").on(t.campaignId, t.name),
    index("factions_campaign_idx").on(t.campaignId),
  ],
);

/**
 * Relationship milestone events — append-only log. RelationshipAnalyzer
 * (Chronicler's consultant) writes these when it detects moments like
 * first_trust, first_vulnerability, first_sacrifice, first_argument.
 * KA reads recent ones to maintain relational continuity.
 */
export const relationshipEvents = pgTable(
  "relationship_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    npcId: uuid("npc_id")
      .notNull()
      .references(() => npcs.id, { onDelete: "cascade" }),
    /**
     * first_trust | first_vulnerability | first_sacrifice | first_humor |
     * first_argument | reconciliation | betrayal | protective_bond | ...
     * Free-form enum so RelationshipAnalyzer can nominate new ones.
     */
    milestoneType: text("milestone_type").notNull(),
    /** Short prose (1-2 sentences) grounding the milestone in what happened. */
    evidence: text("evidence").notNull(),
    turnNumber: integer("turn_number").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("relationship_events_campaign_idx").on(t.campaignId),
    index("relationship_events_npc_idx").on(t.npcId),
  ],
);

/**
 * Semantic memory — distilled cross-turn facts (§9.1 categories).
 * `embedding` column is pgvector-ready but stays null at M1 (embedder
 * decision is M4 per §9.3). Read path uses category + heat until
 * embeddings populate.
 */
export const semanticMemories = pgTable(
  "semantic_memories",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    /** §9.1 category: relationship | location_fact | ability_fact | lore | etc. */
    category: text("category").notNull(),
    /** Distilled fact in 1-3 sentences. */
    content: text("content").notNull(),
    /**
     * Heat 0-100. Decays with turn distance per category's decay rate
     * (§9.1 decay curves). Default 100 — v3-parity: start hot, let decay
     * do the work. Chronicler can write lower for supporting details.
     */
    heat: integer("heat").notNull().default(100),
    /**
     * Decay-modifying flags (§9.1 physics). Respected by decayHeat job +
     * read-path boost-on-access + static-boost retrieval.
     *
     *   plot_critical: bool           — never decays (heat floors at
     *                                   insert-time value; always at
     *                                   most +0.3 relevance boost).
     *   milestone_relationship: bool  — heat floors at 40 regardless of
     *                                   decay multiplier.
     *   boost_priority: number        — caller-chosen static boost
     *                                   (M4-gated retrieval path).
     */
    flags: jsonb("flags").notNull().default(sql`'{}'::jsonb`),
    /** Turn this fact was first written. */
    turnNumber: integer("turn_number").notNull(),
    /** pgvector embedding. Null at M1; M4 decides embedder + backfills. */
    embedding: jsonb("embedding"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("semantic_memories_campaign_idx").on(t.campaignId),
    index("semantic_memories_category_idx").on(t.campaignId, t.category),
  ],
);

/**
 * Foreshadowing seed lifecycle — PLANTED → GROWING → CALLBACK → RESOLVED
 * | ABANDONED | OVERDUE. Chronicler plants candidates; Director ratifies
 * them into real seeds (M6.5 when the ratification path matures).
 */
export const foreshadowingSeeds = pgTable(
  "foreshadowing_seeds",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    status: text("status", {
      enum: ["PLANTED", "GROWING", "CALLBACK", "RESOLVED", "ABANDONED", "OVERDUE"],
    })
      .notNull()
      .default("PLANTED"),
    payoffWindowMin: integer("payoff_window_min").notNull(),
    payoffWindowMax: integer("payoff_window_max").notNull(),
    /** Array of seed ids this one depends on (resolution order). */
    dependsOn: jsonb("depends_on").notNull().default(sql`'[]'::jsonb`),
    /** Array of seed ids that can't co-exist with this one. */
    conflictsWith: jsonb("conflicts_with").notNull().default(sql`'[]'::jsonb`),
    plantedTurn: integer("planted_turn").notNull(),
    resolvedTurn: integer("resolved_turn"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("foreshadowing_seeds_campaign_idx").on(t.campaignId),
    index("foreshadowing_seeds_status_idx").on(t.campaignId, t.status),
  ],
);

/**
 * Director's voice-patterns journal — what's been landing stylistically
 * with this player. KA reads the accumulated patterns in Block 1 as
 * voice_patterns_journal, so an edit here directly shapes the next
 * turn's narration.
 */
export const voicePatterns = pgTable(
  "voice_patterns",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    /** Short observation ("terse two-sentence openings land well"). */
    pattern: text("pattern").notNull(),
    /** What specifically in the narration led to this observation. */
    evidence: text("evidence").notNull().default(""),
    /** Turn Chronicler/Director noted the pattern. */
    turnObserved: integer("turn_observed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("voice_patterns_campaign_idx").on(t.campaignId)],
);

/**
 * Director's notes — advisory guidance KA reads in Block 4 director_notes.
 * Scope controls whether the note is for this turn only, this session,
 * or the remainder of the campaign.
 */
export const directorNotes = pgTable(
  "director_notes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    scope: text("scope", { enum: ["turn", "session", "arc", "campaign"] })
      .notNull()
      .default("session"),
    /** Turn Chronicler/Director wrote the note. */
    createdAtTurn: integer("created_at_turn").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("director_notes_campaign_idx").on(t.campaignId)],
);

/**
 * Spotlight debt per NPC — negative = underexposed, positive = recently
 * on-screen. Director consults this when deciding arc_mode
 * (ensemble_arc vs main_arc). One row per (campaign, npc).
 */
export const spotlightDebt = pgTable(
  "spotlight_debt",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    npcId: uuid("npc_id")
      .notNull()
      .references(() => npcs.id, { onDelete: "cascade" }),
    debt: integer("debt").notNull().default(0),
    updatedAtTurn: integer("updated_at_turn").notNull(),
  },
  (t) => [
    uniqueIndex("spotlight_debt_campaign_npc_key").on(t.campaignId, t.npcId),
    index("spotlight_debt_campaign_idx").on(t.campaignId),
  ],
);

/**
 * Arc plan history — append-only snapshot of Director's arc decisions.
 * Latest row per campaign is the current arc state; older rows are the
 * audit trail for how the arc evolved (useful for retrospectives +
 * future "replay from turn N" stretch goal).
 */
export const arcPlanHistory = pgTable(
  "arc_plan_history",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    currentArc: text("current_arc").notNull(),
    arcPhase: text("arc_phase", {
      enum: ["setup", "development", "complication", "crisis", "resolution"],
    }).notNull(),
    arcMode: text("arc_mode", {
      enum: [
        "main_arc",
        "ensemble_arc",
        "adversary_ensemble_arc",
        "ally_ensemble_arc",
        "investigator_arc",
        "faction_arc",
      ],
    }).notNull(),
    /** Array of beat descriptions Director sketched for upcoming turns. */
    plannedBeats: jsonb("planned_beats").notNull().default(sql`'[]'::jsonb`),
    tensionLevel: numeric("tension_level", { precision: 3, scale: 2 }).notNull().default("0.30"),
    setAtTurn: integer("set_at_turn").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("arc_plan_history_campaign_idx").on(t.campaignId),
    index("arc_plan_history_latest_idx").on(t.campaignId, t.setAtTurn),
  ],
);
