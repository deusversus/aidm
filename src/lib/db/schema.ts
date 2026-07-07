import { EMBEDDING_DIMENSIONS } from "@/lib/llm/embedding-config";
import { isNull } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { provenanceColumns } from "./columns";

/**
 * The v5 substrate schema (blueprint §6; plan M0-substrate.md C3).
 *
 * Nine campaign memory layers + the cross-campaign player profile, standing
 * from M0 per axiom 8 — empty sets from a live layer are valid; missing
 * layers are not. Two layers are deliberately NOT tables:
 *
 *   - Working (layer 1) is the Block 3 store: assembled from the episodic
 *     tail (source of truth) + pins, materialized by the block plumbing
 *     (C5), truncated only at compaction events.
 *   - Canon (layer 5) is cross-campaign: corpora are keyed by source
 *     profile and cached permanently (§8); campaign linkage happens through
 *     the premise contract's profile ids. Canon writes use the envelope
 *     convention turnId = 0, provenance = "sz_research".
 *
 * Every layer table carries the provenance envelope (columns.ts) — the
 * rewind substrate (§6.7). Column-level shapes of layers 4–8 sharpen in M1
 * migrations as writers land; what M0 freezes is the table-per-layer shape,
 * the envelope discipline, and EMBEDDING_DIMENSIONS.
 */

// ---------------------------------------------------------------------------
// Spine
// ---------------------------------------------------------------------------

/** Layer 10 of §6.9 — the player, not the campaign. A returning player is a regular, not a stranger. */
export const players = pgTable("players", {
  /** Clerk user id. */
  id: text().primaryKey(),
  email: text().notNull(),
  /** Cross-campaign taste/patterns/meta-history; thin at M0, player-transparent by doctrine. */
  profile: jsonb().notNull().default({}),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** Soft delete; a hard-delete sweep can follow later. */
  deletedAt: timestamp({ withTimezone: true }),
});

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid().primaryKey().defaultRandom(),
    playerId: text()
      .notNull()
      .references(() => players.id),
    title: text().notNull(),
    status: text().notNull().default("draft"),
    /** The signed §8 handoff artifact (PremiseContract type). */
    premiseContract: jsonb(),
    /** The §8 handoff's other half (OpeningStatePackage type). */
    openingPackage: jsonb(),
    /** Player-facing tier menus (§3): { narration, judgment, probe } model selections. */
    tierModels: jsonb(),
    /** At most one active override, latest wins (§4.2); ArcOverride type. */
    arcOverride: jsonb(),
    /** SZ durable draft (§8): the conversation, resumable across sittings. */
    szTranscript: jsonb(),
    /** SZ quiet-extraction accumulator: observations gathered mid-conversation. */
    szExtraction: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    playerIdx: index("campaigns_player_idx").on(t.playerId),
  }),
);

/**
 * Turns are durable server-side jobs (§5.7); the conte checkpoint enables
 * retry-same-dice. Spine table — no tombstone; the M1 rewind path must
 * decide the dead-timeline disposition of spine turn rows (delete vs
 * status-mark) when it lands, and the (campaign, turnNumber) uniqueness
 * below is part of that decision.
 */
export const turns = pgTable(
  "turns",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    turnNumber: integer().notNull(),
    tier: text().notNull(),
    status: text().notNull().default("pending"),
    playerInput: text().notNull(),
    /** Phase-A checkpoint: the conte + pre-resolved mechanics (Conte type). */
    conte: jsonb(),
    narration: text(),
    /** The commit_scene trailer (CommitScene type). */
    sidecar: jsonb(),
    /** Per-step completion markers for crash-safe catch-up (§5.8). */
    checkpoints: jsonb().notNull().default({}),
    degraded: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => ({
    turnNumberUq: uniqueIndex("turns_campaign_turn_uq").on(t.campaignId, t.turnNumber),
  }),
);

/** Mechanical-state snapshots every ~5 turns — rewind restores from nearest ≤ N (§6.7). */
export const stateSnapshots = pgTable(
  "state_snapshots",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    turnNumber: integer().notNull(),
    state: jsonb().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignIdx: index("state_snapshots_campaign_idx").on(t.campaignId, t.turnNumber),
  }),
);

/** Rewind event log (§6.7): what was rewound, when, how many writes tombstoned. */
export const rewinds = pgTable("rewinds", {
  id: uuid().primaryKey().defaultRandom(),
  campaignId: uuid()
    .notNull()
    .references(() => campaigns.id, { onDelete: "cascade" }),
  rewoundToTurn: integer().notNull(),
  tombstonedCount: integer().notNull().default(0),
  reason: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * The cost meter (§3, §9.5): every model call — Anthropic, Voyage, later
 * media — lands here with cache accounting, from M0. If it isn't metered,
 * it doesn't ship.
 */
export const modelCalls = pgTable(
  "model_calls",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid().references(() => campaigns.id, { onDelete: "set null" }),
    turnNumber: integer(),
    provider: text().notNull(),
    model: text().notNull(),
    /** narration | judgment | probe | embedding (media tiers join at M5). */
    tier: text().notNull(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cacheReadInputTokens: integer().notNull().default(0),
    cacheCreationInputTokens: integer().notNull().default(0),
    costUsd: numeric({ precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: integer(),
    /** Fable→Opus server-side fallback fired (§3) — Sakkan-relevant. */
    fallbackUsed: boolean().notNull().default(false),
    traceId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    campaignIdx: index("model_calls_campaign_idx").on(t.campaignId),
  }),
);

/**
 * Source profiles (§8): research output, cached permanently, cross-campaign
 * — spine-adjacent reference data like canon_chunks (which key on
 * profiles.id). Not a memory layer; sourcing lives in researchProvenance.
 */
export const profiles = pgTable("profiles", {
  /** Slug, e.g. "cowboy_bebop" — canon_chunks.profileId points here. */
  id: text().primaryKey(),
  title: text().notNull(),
  anilistId: integer(),
  malId: integer(),
  /** The typed Profile contract (types/profile.ts). */
  profile: jsonb().notNull(),
  /** micro | standard | complex | epic — research depth class (§8). */
  scopeClass: text(),
  /** Sources, fetch timestamps, synthesis versions, judge verdicts. */
  researchProvenance: jsonb().notNull().default({}),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Layer 2 — Compacted history (narrated beats; §6.2)
// ---------------------------------------------------------------------------

export const compactedBeats = pgTable(
  "compacted_beats",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    content: text().notNull(),
    /** Epoch summaries replace the oldest 50% of beats on Block-2 overflow (§6.2). */
    isEpoch: boolean().notNull().default(false),
    fromTurn: integer().notNull(),
    toTurn: integer().notNull(),
    position: integer().notNull(),
    ...provenanceColumns,
  },
  (t) => ({
    campaignIdx: index("compacted_beats_campaign_idx").on(t.campaignId, t.position),
  }),
);

// ---------------------------------------------------------------------------
// Layer 3 — Episodic (verbatim source of truth + narrated fragments; §6)
// ---------------------------------------------------------------------------

export const episodicRecords = pgTable(
  "episodic_records",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    turnNumber: integer().notNull(),
    playerInput: text().notNull(),
    /** Verbatim narration — Compositor group 1, never decays. */
    narration: text().notNull(),
    /** One narrated fragment per scene — group 2, may lag one turn. */
    narratedFragment: text(),
    ...provenanceColumns,
  },
  (t) => ({
    // Partial: tombstoned rows stay for provenance (§6.7) but must not
    // block the replayed turn from re-inserting its record after a rewind.
    turnUq: uniqueIndex("episodic_campaign_turn_uq")
      .on(t.campaignId, t.turnNumber)
      .where(isNull(t.tombstonedAt)),
  }),
);

// ---------------------------------------------------------------------------
// Layer 4 — Semantic (distilled facts, embedded; heat economy §6.4)
// ---------------------------------------------------------------------------

export const semanticMemories = pgTable(
  "semantic_memories",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    content: text().notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    /** 15-category heat curves carry v3's values as defaults (§6.4). */
    category: text().notNull(),
    /** Decay computed at QUERY time over (baseHeat, lastBoostedAt, category half-life, floor) — no decay cron. */
    baseHeat: real().notNull().default(50),
    lastBoostedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    heatFloor: real().notNull().default(0),
    /** Promotion provenance flag; the promoted fact itself lives in critical_facts (§6.3). */
    plotCritical: boolean().notNull().default(false),
    ...provenanceColumns,
  },
  (t) => ({
    campaignIdx: index("semantic_memories_campaign_idx").on(t.campaignId),
    embeddingIdx: index("semantic_memories_embedding_hnsw").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  }),
);

// ---------------------------------------------------------------------------
// Layer 5 — Canon (page-typed lore corpus per source profile; §6)
// ---------------------------------------------------------------------------

export const canonChunks = pgTable(
  "canon_chunks",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Source profile id — cross-campaign, cached permanently; hybrids read the union, source-tagged. */
    profileId: text().notNull(),
    /** Drives intent-mapped retrieval: ABILITY→techniques, SOCIAL→characters, EXPLORATION→locations (§6). */
    pageType: text().notNull(),
    title: text(),
    content: text().notNull(),
    embedding: vector({ dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    sourceUrl: text(),
    ...provenanceColumns,
  },
  (t) => ({
    profileIdx: index("canon_chunks_profile_idx").on(t.profileId, t.pageType),
    embeddingIdx: index("canon_chunks_embedding_hnsw").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  }),
);

// ---------------------------------------------------------------------------
// Layer 6 — Entity (living prose blocks + structured state; §6.5)
// ---------------------------------------------------------------------------

/**
 * Catalog entities only — transients expire with the scene and never
 * persist (§6.5). Admission is an explicit act: KA sidecar cast delta,
 * Director promotion, or player assertion. Background extraction enriches
 * existing rows and never creates them (v3's guard, carried verbatim).
 */
export const entities = pgTable(
  "entities",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** npc | faction | location | thread. */
    entityType: text().notNull(),
    /** The living prose block — current version; history in entity_versions. */
    block: text().notNull().default(""),
    /** Structured state: relationships, interiority stage, spotlight debt, scar tissue (§7.5). */
    state: jsonb().notNull().default({}),
    status: text().notNull().default("active"),
    ...provenanceColumns,
  },
  (t) => ({
    // Partial (§6.7): a tombstoned catalog entry must not block re-admitting
    // the same-named entity when play continues past a rewind.
    catalogUq: uniqueIndex("entities_campaign_type_name_uq")
      .on(t.campaignId, t.entityType, t.name)
      .where(isNull(t.tombstonedAt)),
  }),
);

export const entityVersions = pgTable(
  "entity_versions",
  {
    id: uuid().primaryKey().defaultRandom(),
    entityId: uuid()
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    block: text().notNull(),
    ...provenanceColumns,
  },
  (t) => ({
    versionUq: uniqueIndex("entity_versions_entity_version_uq")
      .on(t.entityId, t.version)
      .where(isNull(t.tombstonedAt)),
  }),
);

/** Quest rows get their writer in Compositor G2 (§5.8 — v3 ProductionAgent's non-media half). */
export const quests = pgTable(
  "quests",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    name: text().notNull(),
    status: text().notNull().default("active"),
    description: text().notNull().default(""),
    progress: jsonb().notNull().default({}),
    ...provenanceColumns,
  },
  (t) => ({
    campaignIdx: index("quests_campaign_idx").on(t.campaignId),
  }),
);

// ---------------------------------------------------------------------------
// Layer 7 — Intent (arc state, seeds, consequences; §7)
// ---------------------------------------------------------------------------

/** ArcObject rows (§7.3): typed strata, budget, payoff contract, canon weight. */
export const arcs = pgTable(
  "arcs",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    name: text().notNull(),
    stratum: text().notNull(),
    dramaticQuestion: text().notNull(),
    shape: text().notNull(),
    budget: jsonb().notNull(),
    phase: text().notNull(),
    payoffContract: jsonb().notNull().default([]),
    status: text().notNull().default("planned"),
    canonWeight: text().notNull().default("full_canon"),
    parentId: uuid().references((): AnyPgColumn => arcs.id),
    ...provenanceColumns,
  },
  (t) => ({
    campaignIdx: index("arcs_campaign_idx").on(t.campaignId, t.status),
  }),
);

/**
 * The seed ledger (§7.6): lifecycle, payoff windows, urgency-on-mention,
 * dependency gates. Causal edges live in `dependencies` at M0; the graph
 * machinery hardens at M3.
 */
export const seeds = pgTable(
  "seeds",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    description: text().notNull(),
    expectedPayoff: text(),
    status: text().notNull().default("planted"),
    plantedTurn: integer().notNull(),
    /** { from, to } in turns; overdue → tension (§7.6). */
    payoffWindow: jsonb(),
    urgency: real().notNull().default(0),
    /** Seed ids gating this one. */
    dependencies: jsonb().notNull().default([]),
    mentionCount: integer().notNull().default(0),
    resolvedTurn: integer(),
    ...provenanceColumns,
  },
  (t) => ({
    campaignIdx: index("seeds_campaign_idx").on(t.campaignId, t.status),
  }),
);

export const consequences = pgTable(
  "consequences",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    description: text().notNull(),
    active: boolean().notNull().default(true),
    ...provenanceColumns,
  },
  (t) => ({
    campaignIdx: index("consequences_campaign_idx").on(t.campaignId, t.active),
  }),
);

// ---------------------------------------------------------------------------
// Layer 8 — Learned (pencil marks + session memos + voice journal; §6.6)
// ---------------------------------------------------------------------------

export const pencilMarks = pgTable(
  "pencil_marks",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    /** axis | voice_feature | craft_note (PencilMark type). */
    kind: text().notNull(),
    topic: text().notNull(),
    direction: text().notNull(),
    evidence: text().notNull(),
    /** Supersession: kept for provenance, excluded from rendering. Never lost ≠ never demoted. */
    supersededBy: uuid().references((): AnyPgColumn => pencilMarks.id),
    ...provenanceColumns,
  },
  (t) => ({
    campaignIdx: index("pencil_marks_campaign_idx").on(t.campaignId, t.kind, t.topic),
  }),
);

/** Session lifecycle records (§9.4): memo + voice journal + yokoku at close. */
export const sessionRecords = pgTable(
  "session_records",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    sessionNumber: integer().notNull(),
    openedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp({ withTimezone: true }),
    /** explicit | idle_timeout | rolling_checkpoint (§9.4 close triggers). */
    closeTrigger: text(),
    directorMemo: text(),
    voiceJournal: text(),
    yokoku: text(),
    ...provenanceColumns,
  },
  (t) => ({
    sessionUq: uniqueIndex("session_records_campaign_session_uq")
      .on(t.campaignId, t.sessionNumber)
      .where(isNull(t.tombstonedAt)),
  }),
);

// ---------------------------------------------------------------------------
// Layer 9 — Critical (guaranteed injection every turn, trivial included; §6.3)
// ---------------------------------------------------------------------------

export const criticalFacts = pgTable(
  "critical_facts",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    content: text().notNull(),
    /** sz_fact | promoted | contract (finitude/intensity live here as records too). */
    category: text().notNull(),
    /** For promoted facts: the semantic memory that earned promotion. */
    sourceMemoryId: uuid(),
    /** Dailies can demote stale criticals back to semantic-with-floor (§6.3) — earned and revocable, not a ratchet. */
    demotedAt: timestamp({ withTimezone: true }),
    ...provenanceColumns,
  },
  (t) => ({
    campaignIdx: index("critical_facts_campaign_idx").on(t.campaignId),
  }),
);

/** The override ledger (§5.4): hard constraints, injected every turn including douga. */
export const overrides = pgTable(
  "overrides",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    content: text().notNull(),
    active: boolean().notNull().default(true),
    removedAt: timestamp({ withTimezone: true }),
    ...provenanceColumns,
  },
  (t) => ({
    campaignIdx: index("overrides_campaign_idx").on(t.campaignId, t.active),
  }),
);

/** Pins (§5.4): player-selected verbatim passages, ≤5 / ≤2k tokens (enforced in the block store). */
export const pins = pgTable(
  "pins",
  {
    id: uuid().primaryKey().defaultRandom(),
    campaignId: uuid()
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    content: text().notNull(),
    position: integer().notNull().default(0),
    /**
     * Turn the pinned passage was selected from. Dedup keys on THIS vs the
     * compaction watermark (source exchange still in the verbatim tail →
     * pin withheld), never on window text — text-scanning dedup flips
     * membership mid-session when narration echoes the pin, invalidating
     * the B3 prefix (C5 audit). 0 = unknown/pre-play → always rendered.
     */
    sourceTurn: integer().notNull().default(0),
    ...provenanceColumns,
  },
  (t) => ({
    campaignIdx: index("pins_campaign_idx").on(t.campaignId, t.position),
  }),
);
