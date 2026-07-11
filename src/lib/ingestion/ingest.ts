import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import {
  campaigns,
  canonChunks,
  criticalFacts,
  entities,
  entityVersions,
  semanticMemories,
} from "@/lib/db/schema";
import { identityKey, isProtagonistName } from "@/lib/entity-identity";
import {
  MERGE_AUTO_CONFIDENCE,
  MERGE_CANDIDATE_MAX_DISTANCE,
  pairLikelySame,
} from "@/lib/entity/janitor";
import { callProbe } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import { cosineSimilarity, embedTexts } from "@/lib/llm/voyage";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

/**
 * Universal ingestion (blueprint §5.4, §6.5): the ONE subsystem that turns
 * player language into world facts — extractor → resolver → editor posture →
 * typed provenance-carrying writes. It runs identically in Session Zero
 * (quiet extraction) and gameplay (world assertions); §5.4's principle is
 * that the player's words are always a world-building conversation, never a
 * pew where the engine preaches.
 *
 * The resolver is the "never duplicates" guard: the canonical example is a
 * Bebop hybrid where "The Syndicate" LINKS to canon rather than minting a
 * second copy. Entity resolution checks campaign state first, then the canon
 * corpus; a strong canon match seeds the new catalog entity FROM the canon
 * content (link, don't invent) instead of the player's paraphrase.
 *
 * Player authority is confidence 1 — a player assertion is world truth, one
 * of the three catalog-minting authorities (§6.5); background extraction from
 * KA prose is the path that never creates, not this one.
 */

/** cosine distance (`<=>`) below which a canon hit counts as THE entity — link, don't duplicate. */
export const CANON_MATCH_DISTANCE = 0.45;
/** How much canon content seeds a linked entity's opening block. */
const CANON_BLOCK_CHARS = 600;
/** Title + content-head window scanned for the entity name when confirming a canon link. */
const CANON_HEAD_CHARS = 240;

export interface IngestedWrite {
  kind: "entity_created" | "entity_enriched" | "semantic_fact" | "critical_fact";
  id: string;
  summary: string;
}

export interface IngestionResult {
  writes: IngestedWrite[];
  /** CLARIFY posture — one question back to the player; nothing written for the ambiguous fact. */
  clarify?: string;
  /** FLAG posture — non-blocking craft notes for the Director (tier-inflation, convenience, mystery-foreclosure). */
  flags: string[];
}

/** null → undefined for optionals the probe may emit as `null` (§ turn.ts precedent). */
const nullableOptionalString = z.preprocess(
  (v) => (v === null ? undefined : v),
  z.string().optional(),
);

const FactKind = z.enum(["world_fact", "cast_fact", "faction", "location", "thread", "backstory"]);
type FactKind = z.infer<typeof FactKind>;
const Posture = z.enum(["accept", "clarify", "flag"]);

const ExtractedFact = z.object({
  kind: FactKind,
  /** Present when the fact is ABOUT a nameable catalog entity (faction/npc/location/thread). */
  entity_name: nullableOptionalString,
  content: z.string(),
  posture: Posture,
  /** CLARIFY: the single question to ask. FLAG: the craft concern. ACCEPT: omitted. */
  posture_reason: nullableOptionalString,
});

export const IngestionExtraction = z.object({ facts: z.array(ExtractedFact).default([]) });
export type IngestionExtraction = z.infer<typeof IngestionExtraction>;

const EXTRACTOR_SYSTEM = [
  "You are the world-assertion editor for a collaborative story engine. The",
  "player has spoken; your job is to capture the world facts their words",
  "assert, NOT to answer a quiz. The player's language is always",
  "world-building: a single sentence can mint a faction, a location, an",
  "offscreen character, backstory pressure, and a tonal bid at once. Extract",
  "each discrete fact.",
  "",
  "For every fact set: kind (world_fact | cast_fact | faction | location |",
  "thread | backstory); content (the fact, stated cleanly in third person);",
  "entity_name ONLY when the fact is about a nameable catalog entity",
  "(a faction, a person/NPC, a place, or an ongoing thread) — the exact name",
  "the player used; and a posture.",
  "",
  "POSTURE is the editor's stance (§5.4):",
  "- accept (DEFAULT, the overwhelming majority): the player authored canon.",
  "  Take it as true. Player words outrank the engine's inference.",
  "- clarify: ONLY for a genuine LOCAL PHYSICAL ambiguity (which of two",
  "  established places did they mean?) or a DIRECT contradiction of an",
  "  established critical fact. Set posture_reason to the SINGLE plain",
  "  question to ask the player. Nothing is written for a clarify fact — use",
  "  it sparingly; do not clarify mere novelty.",
  "- flag: the fact is accepted AND written, but carries a non-blocking craft",
  "  concern for the Director — tier-inflation (a power spike that breaks the",
  "  world's scale), convenience (a too-tidy solution), or mystery-",
  "  foreclosure (closing a question the story was living inside). Set",
  "  posture_reason to the concern. FLAG never blocks the write.",
  "",
  "When in doubt, accept. There is no REJECT.",
].join(" ");

function entityTypeForKind(kind: FactKind): "npc" | "faction" | "location" | "thread" {
  switch (kind) {
    case "faction":
      return "faction";
    case "location":
      return "location";
    case "thread":
      return "thread";
    default:
      // cast_fact, backstory, world_fact naming an entity → an actor/force.
      return "npc";
  }
}

function categoryForKind(kind: FactKind): string {
  switch (kind) {
    case "world_fact":
    case "faction":
    case "location":
      return "world_state";
    default:
      // cast_fact, backstory, thread
      return "fact";
  }
}

interface EntityRef {
  id: string;
  name: string;
  entityType: string;
  block: string;
}

/**
 * Turn a single player assertion into world facts. Identical for gameplay and
 * Session Zero; the compositor calls this with WORLD_BUILDING-classified
 * player input, SZ's `record_extraction` binds to the same entry point.
 */
export async function ingestAssertion(
  db: Db,
  campaignId: string,
  turnNumber: number,
  text: string,
  opts: { profileIds: string[]; provenance?: string },
): Promise<IngestionResult> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) throw new Error("campaign not found");
  const parsedSelection = TierSelection.safeParse(campaign.tierModels);
  const selection = parsedSelection.success ? parsedSelection.data : DEV_TIER_SELECTION;

  const provenance = opts.provenance ?? "player_assertion";
  const envelope = { turnId: turnNumber, provenance, confidence: 1 } as const;

  // --- Context: the editor sees the critical facts + the existing catalog ---
  const [criticalRows, entityRows] = await Promise.all([
    db
      .select({ content: criticalFacts.content })
      .from(criticalFacts)
      .where(and(eq(criticalFacts.campaignId, campaignId), notTombstoned(criticalFacts))),
    db
      .select({
        id: entities.id,
        name: entities.name,
        entityType: entities.entityType,
        block: entities.block,
      })
      .from(entities)
      .where(and(eq(entities.campaignId, campaignId), notTombstoned(entities))),
  ]);

  // --- Extractor: ONE probe call (§5.4 pipeline step 1) ----------------------
  const extraction = await callProbe(selection, {
    name: "world_assertion_extract",
    schema: IngestionExtraction,
    campaignId,
    turnNumber,
    system: EXTRACTOR_SYSTEM,
    prompt: [
      criticalRows.length > 0
        ? `ESTABLISHED CRITICAL FACTS (a direct contradiction is the only reason to clarify):\n${criticalRows.map((c) => `- ${c.content}`).join("\n")}`
        : "ESTABLISHED CRITICAL FACTS: (none yet)",
      entityRows.length > 0
        ? `EXISTING CATALOG ENTITIES (reuse the exact name when the assertion is about one):\n${entityRows.map((e) => `- ${e.name} (${e.entityType})`).join("\n")}`
        : "EXISTING CATALOG ENTITIES: (none yet)",
      "",
      `PLAYER ASSERTION:\n${text}`,
    ].join("\n"),
    maxTokens: 2_000,
  });

  const writes: IngestedWrite[] = [];
  const flags: string[] = [];
  const clarifyQuestions: string[] = [];

  // CLARIFY writes NOTHING (§5.4): peel those off first.
  const writable = extraction.facts.filter((f) => {
    if (f.posture === "clarify") {
      clarifyQuestions.push(f.posture_reason?.trim() || `Could you clarify: ${f.content}`);
      return false;
    }
    return true;
  });

  if (writable.length === 0) {
    return {
      writes,
      flags,
      ...(clarifyQuestions.length > 0 ? { clarify: clarifyQuestions.join(" ") } : {}),
    };
  }

  // --- Resolver embeddings (§5.4 step 2) -------------------------------------
  // In-memory catalog keyed by NORMALIZED name (§6.5 identity guard — the live
  // turn-3 defect: "the protagonist" exact-missed "The Protagonist (unnamed)"
  // and minted a third PC row). Protagonist-flavored npcs also register under
  // a sentinel so every placeholder spelling resolves to the same row. Grows
  // as this call mints entities so a second fact naming the same NEW entity
  // enriches, not dupes.
  const PROTAGONIST_KEY = "#protagonist#";
  const catalog = new Map<string, EntityRef>();
  for (const e of entityRows) {
    // Empty-normalization guard (§6.5, M2 C1): an all-punctuation name ("???")
    // normalizes to "" — never register the empty key, or two such names collide
    // into one row (M1-audit note). identityKey returns null there.
    const key = identityKey(e.name);
    if (key) catalog.set(key, e);
    if (e.entityType === "npc" && isProtagonistName(e.name)) catalog.set(PROTAGONIST_KEY, e);
  }
  const lookupEntity = (rawName: string): EntityRef | undefined => {
    const key = identityKey(rawName);
    return (
      (key ? catalog.get(key) : undefined) ??
      (isProtagonistName(rawName) ? catalog.get(PROTAGONIST_KEY) : undefined)
    );
  };

  // Names embedded ONCE per assertion (§5.4 step 2 + §6.5 mint-time guard): the
  // unmatched candidate names (each a canon-lookup subject and a mint-guard
  // subject) plus the same-type catalog names the guard compares them against.
  const candidateNames = [
    ...new Set(
      writable
        .map((f) => f.entity_name?.trim())
        .filter((n): n is string => !!n && !lookupEntity(n)),
    ),
  ];
  const candidateTypes = new Set<string>(
    writable
      .filter((f) => {
        const n = f.entity_name?.trim();
        return !!n && !lookupEntity(n);
      })
      .map((f) => entityTypeForKind(f.kind)),
  );
  // Only same-type catalog names can be guard targets; an empty same-type
  // catalog means the guard is skipped entirely (bounded added latency).
  const guardCatalogEntities = entityRows.filter((e) => candidateTypes.has(e.entityType));
  const namesToEmbed = [
    ...new Set([...candidateNames, ...guardCatalogEntities.map((e) => e.name)]),
  ];
  const nameEmbeddings =
    namesToEmbed.length > 0
      ? await embedTexts(namesToEmbed, {
          inputType: "query",
          patience: "interactive",
          campaignId,
          turnNumber,
        })
      : [];
  const nameEmbByKey = new Map<string, number[]>();
  namesToEmbed.forEach((n, i) => {
    const key = identityKey(n);
    const emb = nameEmbeddings[i];
    if (key && emb) nameEmbByKey.set(key, emb);
  });

  /**
   * §6.5 mint-time semantic guard (M2 C1): before minting an unmatched name,
   * find the nearest same-type catalog entity by name embedding; a near-hit the
   * deterministic tier missed (different spelling, same meaning) that one probe
   * confirms means ENRICH that row instead of minting a parallel one. Reads the
   * live `catalog` (grows as this assertion mints), so a second new name for the
   * same thing within one assertion also folds in.
   */
  const mintGuardMatch = async (
    candName: string,
    candType: string,
    candBlock: string,
  ): Promise<EntityRef | undefined> => {
    const ck = identityKey(candName);
    if (!ck) return undefined;
    const candEmb = nameEmbByKey.get(ck);
    if (!candEmb) return undefined;
    const seen = new Set<string>();
    let best: { ref: EntityRef; distance: number } | undefined;
    for (const ref of catalog.values()) {
      if (ref.entityType !== candType || seen.has(ref.id)) continue;
      seen.add(ref.id);
      const ek = identityKey(ref.name);
      if (!ek || ek === ck) continue;
      const emb = nameEmbByKey.get(ek);
      if (!emb) continue;
      const distance = 1 - cosineSimilarity(candEmb, emb);
      if (!best || distance < best.distance) best = { ref, distance };
    }
    if (!best || best.distance >= MERGE_CANDIDATE_MAX_DISTANCE) return undefined;
    const verdict = await pairLikelySame(db, selection, {
      campaignId,
      turnNumber,
      a: {
        id: best.ref.id,
        name: best.ref.name,
        entityType: best.ref.entityType,
        block: best.ref.block,
      },
      b: { name: candName, block: candBlock },
    });
    // AUTO bar, not the suggest floor (C1 audit #4): a false enrich silently
    // swallows a genuine new entity with no recovery affordance, while a
    // false mint is caught by the janitor at session close. Mid-band mints.
    return verdict.same && verdict.confidence >= MERGE_AUTO_CONFIDENCE ? best.ref : undefined;
  };

  // Enrich a resolved catalog entity (append + version row) — shared by the
  // deterministic-match path and the semantic mint-guard path.
  const enrichExisting = async (target: EntityRef, content: string): Promise<void> => {
    const newBlock = target.block ? `${target.block}\n- ${content}` : content;
    const [{ maxVersion } = { maxVersion: null }] = await db
      .select({ maxVersion: sql<number | null>`max(${entityVersions.version})` })
      .from(entityVersions)
      .where(eq(entityVersions.entityId, target.id));
    const version = (maxVersion ? Number(maxVersion) : 0) + 1;
    await db.update(entities).set({ block: newBlock }).where(eq(entities.id, target.id));
    await db
      .insert(entityVersions)
      .values({ entityId: target.id, version, block: newBlock, ...envelope });
    target.block = newBlock;
    writes.push({
      kind: "entity_enriched",
      id: target.id,
      summary: `Enriched ${target.entityType} "${target.name}"`,
    });
  };

  // Semantic-layer embeddings for every writable fact (§5.4 step 3), batched.
  const semanticEmbeddings = await embedTexts(
    writable.map((f) => f.content),
    { inputType: "document", patience: "interactive", campaignId, turnNumber },
  );

  // --- Writes (§5.4 step 3): every row carries the provenance envelope -------
  for (let i = 0; i < writable.length; i++) {
    const fact = writable[i];
    if (!fact) continue;
    const semanticEmb = semanticEmbeddings[i];
    if (!semanticEmb) throw new Error(`ingestAssertion: missing embedding for fact ${i}`);

    const name = fact.entity_name?.trim();
    if (name) {
      const entityType = entityTypeForKind(fact.kind);
      // Deterministic match, then the semantic mint-guard (different spelling,
      // same meaning), then mint.
      const existing = lookupEntity(name) ?? (await mintGuardMatch(name, entityType, fact.content));
      if (existing) {
        // A guard hit registers the candidate name so later facts naming it
        // this assertion resolve directly (no repeat probe).
        const key = identityKey(name);
        if (key && !catalog.has(key)) catalog.set(key, existing);
        await enrichExisting(existing, fact.content);
      } else {
        // Unmatched named entity → resolve against canon, then mint.
        const nk = identityKey(name);
        const resolved = await resolveCanon(
          db,
          opts.profileIds,
          name,
          nk ? nameEmbByKey.get(nk) : undefined,
        );
        const block = resolved
          ? `[canon:${resolved.profileId}] ${resolved.content.slice(0, CANON_BLOCK_CHARS).trim()}`
          : fact.content;
        const [created] = await db
          .insert(entities)
          .values({ campaignId, name, entityType, block, ...envelope })
          .returning({ id: entities.id });
        if (!created) throw new Error("ingestAssertion: entity insert failed");
        // Creation writes version 1 so a rewind can always restore the block
        // to a known state — enrichment versions stack on top (C6 audit).
        await db
          .insert(entityVersions)
          .values({ entityId: created.id, version: 1, block, ...envelope })
          .onConflictDoNothing();
        const ref = { id: created.id, name, entityType, block };
        if (nk) catalog.set(nk, ref);
        if (entityType === "npc" && isProtagonistName(name)) catalog.set(PROTAGONIST_KEY, ref);
        writes.push({
          kind: "entity_created",
          id: created.id,
          summary: `Created ${entityType} "${name}"${resolved ? ` (linked to canon: ${resolved.profileId})` : ""}`,
        });
      }
    }

    // Every writable fact also lands as a semantic memory (§5.4 step 3).
    const [mem] = await db
      .insert(semanticMemories)
      .values({
        campaignId,
        content: fact.content,
        embedding: semanticEmb,
        category: categoryForKind(fact.kind),
        baseHeat: 100,
        heatFloor: 1,
        lastBoostedTurn: turnNumber,
        ...envelope,
      })
      .returning({ id: semanticMemories.id });
    if (!mem) throw new Error("ingestAssertion: semantic insert failed");
    writes.push({ kind: "semantic_fact", id: mem.id, summary: fact.content.slice(0, 120) });

    // FLAG writes normally AND surfaces the craft note (§5.4).
    if (fact.posture === "flag") {
      flags.push(fact.posture_reason?.trim() || `Craft flag on: ${fact.content}`);
    }
  }

  return {
    writes,
    flags,
    ...(clarifyQuestions.length > 0 ? { clarify: clarifyQuestions.join(" ") } : {}),
  };
}

/**
 * Canon resolution (§5.4 "checks canon first"): a top hit that both names the
 * entity (in its title or content-head) and sits within CANON_MATCH_DISTANCE
 * means the entity IS canon — return its source content so the caller seeds
 * the block from canon rather than inventing a parallel copy.
 */
async function resolveCanon(
  db: Db,
  profileIds: string[],
  name: string,
  queryEmbedding: number[] | undefined,
): Promise<{ profileId: string; content: string } | null> {
  if (profileIds.length === 0 || !queryEmbedding) return null;
  const vec = `[${queryEmbedding.join(",")}]`;
  const [top] = await db
    .select({
      profileId: canonChunks.profileId,
      title: canonChunks.title,
      content: canonChunks.content,
      distance: sql<number>`${canonChunks.embedding} <=> ${vec}::vector`,
    })
    .from(canonChunks)
    .where(and(inArray(canonChunks.profileId, profileIds), notTombstoned(canonChunks)))
    .orderBy(sql`${canonChunks.embedding} <=> ${vec}::vector`)
    .limit(1);
  if (!top || Number(top.distance) >= CANON_MATCH_DISTANCE) return null;
  const haystack = `${top.title ?? ""} ${top.content.slice(0, CANON_HEAD_CHARS)}`.toLowerCase();
  if (!haystack.includes(name.toLowerCase())) return null;
  return { profileId: top.profileId, content: top.content };
}
