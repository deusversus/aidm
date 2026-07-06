import { z } from "zod";

/**
 * Zod shapes for Chronicler-written entities. Mirror the Drizzle
 * tables in `src/lib/state/schema.ts` — keep the two in sync.
 *
 * Every field is validated-on-read by tools that consume these rows
 * (read-path tools like `get_npc_details`, `list_known_npcs`, etc.)
 * and validated-on-write by Chronicler's tool-argument schemas
 * (register_npc, update_npc, write_semantic_memory, etc.).
 *
 * Names match v3's WorldBuilder NPCDetails shape for continuity;
 * storyboarded memory fragments (§9.0 write path) land here too when
 * the memory writer matures at M4+.
 */

export const NpcRole = z.enum(["ally", "rival", "mentor", "enemy", "neutral", "acquaintance"]);
export type NpcRole = z.infer<typeof NpcRole>;

export const EnsembleArchetype = z.enum([
  "struggler",
  "heart",
  "skeptic",
  "dependent",
  "equal",
  "observer",
  "rival",
]);
export type EnsembleArchetype = z.infer<typeof EnsembleArchetype>;

export const Npc = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  name: z.string().min(1),
  role: z.string().default("acquaintance"),
  personality: z.string().default(""),
  goals: z.array(z.string()).default([]),
  secrets: z.array(z.string()).default([]),
  faction: z.string().nullable().default(null),
  visualTags: z.array(z.string()).default([]),
  knowledgeTopics: z.record(z.string(), z.enum(["expert", "moderate", "basic"])).default({}),
  powerTier: z.string().default("T10"),
  ensembleArchetype: z.string().nullable().default(null),
  firstSeenTurn: z.number().int().positive(),
  lastSeenTurn: z.number().int().positive(),
});
export type Npc = z.infer<typeof Npc>;

export const Location = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  name: z.string().min(1),
  details: z.record(z.string(), z.unknown()).default({}),
  firstSeenTurn: z.number().int().positive(),
  lastSeenTurn: z.number().int().positive(),
});
export type Location = z.infer<typeof Location>;

export const Faction = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  name: z.string().min(1),
  details: z.record(z.string(), z.unknown()).default({}),
});
export type Faction = z.infer<typeof Faction>;

/** Append-only log of relationship milestones between player + NPCs. */
export const RelationshipEvent = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  npcId: z.string().uuid(),
  milestoneType: z.string().min(1),
  evidence: z.string().min(1),
  turnNumber: z.number().int().positive(),
});
export type RelationshipEvent = z.infer<typeof RelationshipEvent>;

/** §9.1 semantic-memory category. Free-form string at M1 — Chronicler
 * can nominate new categories; M4 may tighten to an enum. */
export const SemanticMemory = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  category: z.string().min(1),
  content: z.string().min(1),
  heat: z.number().int().min(0).max(100),
  turnNumber: z.number().int().positive(),
  /** pgvector embedding; null until M4 embedder decision. */
  embedding: z.array(z.number()).nullable().default(null),
});
export type SemanticMemory = z.infer<typeof SemanticMemory>;

export const ForeshadowingStatus = z.enum([
  "PLANTED",
  "GROWING",
  "CALLBACK",
  "RESOLVED",
  "ABANDONED",
  "OVERDUE",
]);
export type ForeshadowingStatus = z.infer<typeof ForeshadowingStatus>;

export const ForeshadowingSeed = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().min(1),
  status: ForeshadowingStatus.default("PLANTED"),
  payoffWindowMin: z.number().int().min(1),
  payoffWindowMax: z.number().int().min(1),
  dependsOn: z.array(z.string().uuid()).default([]),
  conflictsWith: z.array(z.string().uuid()).default([]),
  plantedTurn: z.number().int().positive(),
  resolvedTurn: z.number().int().positive().nullable().default(null),
});
export type ForeshadowingSeed = z.infer<typeof ForeshadowingSeed>;

export const VoicePattern = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  pattern: z.string().min(1),
  evidence: z.string().default(""),
  turnObserved: z.number().int().positive(),
});
export type VoicePattern = z.infer<typeof VoicePattern>;

export const DirectorNoteScope = z.enum(["turn", "session", "arc", "campaign"]);
export type DirectorNoteScope = z.infer<typeof DirectorNoteScope>;

export const DirectorNote = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  content: z.string().min(1),
  scope: DirectorNoteScope.default("session"),
  createdAtTurn: z.number().int().positive(),
});
export type DirectorNote = z.infer<typeof DirectorNote>;

export const SpotlightDebt = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  npcId: z.string().uuid(),
  debt: z.number().int(),
  updatedAtTurn: z.number().int().positive(),
});
export type SpotlightDebt = z.infer<typeof SpotlightDebt>;

export const ArcPhase = z.enum(["setup", "development", "complication", "crisis", "resolution"]);
export type ArcPhase = z.infer<typeof ArcPhase>;

export const ArcMode = z.enum([
  "main_arc",
  "ensemble_arc",
  "adversary_ensemble_arc",
  "ally_ensemble_arc",
  "investigator_arc",
  "faction_arc",
]);
export type ArcMode = z.infer<typeof ArcMode>;

export const ArcPlanHistoryEntry = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  currentArc: z.string().min(1),
  arcPhase: ArcPhase,
  arcMode: ArcMode,
  plannedBeats: z.array(z.string()).default([]),
  tensionLevel: z.number().min(0).max(1),
  setAtTurn: z.number().int().positive(),
});
export type ArcPlanHistoryEntry = z.infer<typeof ArcPlanHistoryEntry>;

export const ContextBlockType = z.enum(["arc", "thread", "quest", "npc", "faction", "location"]);
export type ContextBlockType = z.infer<typeof ContextBlockType>;

export const ContextBlockStatus = z.enum(["active", "closed", "archived"]);
export type ContextBlockStatus = z.infer<typeof ContextBlockStatus>;

/**
 * Context block — per-entity living prose summary that survives across
 * sessions. Phase 3 of v3-audit closure (docs/plans/v3-audit-closure.md).
 *
 * A context block is distilled story-state for one entity — an arc's
 * current position, a quest's trajectory, an NPC's personality + active
 * goals + recent changes. KA reads these at session start in place of
 * reconstructing campaign state from scattered memory tool calls.
 */
export const ContextBlock = z.object({
  id: z.string().uuid(),
  campaignId: z.string().uuid(),
  blockType: ContextBlockType,
  entityId: z.string().uuid().nullable().default(null),
  entityName: z.string().min(1),
  content: z.string().min(1),
  continuityChecklist: z.record(z.string(), z.unknown()).default({}),
  status: ContextBlockStatus.default("active"),
  version: z.number().int().min(1).default(1),
  firstTurn: z.number().int().positive(),
  lastUpdatedTurn: z.number().int().positive(),
});
export type ContextBlock = z.infer<typeof ContextBlock>;
