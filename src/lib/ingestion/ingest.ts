import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import {
  campaigns,
  canonChunks,
  criticalFacts,
  entities,
  entityVersions,
  profiles,
  semanticMemories,
} from "@/lib/db/schema";
import { identityKey, isProtagonistName, marksPlayerProtagonistState } from "@/lib/entity-identity";
import {
  MERGE_AUTO_CONFIDENCE,
  MERGE_CANDIDATE_MAX_DISTANCE,
  pairLikelySame,
} from "@/lib/entity/janitor";
import { STRUCTURED_SMALL } from "@/lib/llm/budgets";
import { callJudgment, callProbe } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import { cosineSimilarity, embedTexts } from "@/lib/llm/voyage";
import { VoiceCard } from "@/lib/types/profile";
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
/** Bounded (~200 char) voice fingerprint stamped onto a canon-linked speaking-cast row. */
const VOICE_CARD_FINGERPRINT_CHARS = 200;

/** Narrow parse over the profile jsonb — only the voice cards the stamp reads. */
const ProfileVoiceCards = z.object({
  ip_mechanics: z.object({ voice_cards: z.array(VoiceCard) }),
});

/**
 * §4.7/§6.5 (M2 C8): compress a research voice card into the ~200-char
 * fingerprint the KA reads on speaking-cast turns — how the character sounds,
 * not their biography. Stamped into `state.voice_card` when a new NPC links to
 * canon (below), rendered as a `voice:` line by fetchEntityCards.
 */
function voiceCardFingerprint(card: z.infer<typeof VoiceCard>): string {
  const phrase = card.signature_phrases.find((p) => p.trim().length > 0);
  const text = [
    card.speech_patterns,
    card.dialogue_rhythm,
    card.emotional_expression.toLowerCase(),
    phrase ? `e.g. "${phrase}"` : "",
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("; ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > VOICE_CARD_FINGERPRINT_CHARS
    ? `${text.slice(0, VOICE_CARD_FINGERPRINT_CHARS).trimEnd()}…`
    : text;
}

/**
 * Normalized-containment match (§5.4 correction semantics, M2 C3): lowercase +
 * collapse whitespace, then test either-direction substring. Conservative by
 * design — no fuzzy scoring — this is how a player correction binds to the
 * exact dossier line or critical fact it retires. Empty operands never match.
 */
const normalizeForMatch = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
function normalizedContains(a: string, b: string): boolean {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  return na.length > 0 && nb.length > 0 && (na.includes(nb) || nb.includes(na));
}

export interface IngestedWrite {
  kind:
    | "entity_created"
    | "entity_enriched"
    /** §5.4 correction (M2 C3): the living block was REVISED, not appended — the record obeyed. */
    | "entity_revised"
    | "semantic_fact"
    | "critical_fact"
    /** §5.4 correction (M2 C3): a critical fact was tombstoned and replaced by player word. */
    | "critical_fact_replaced";
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
  /**
   * §5.4 relational resolution (M2 C2): when the fact's entity is defined by
   * its relation to an EXISTING catalog entity ("my mother", "your master"),
   * this carries the anchor's exact catalog name. A relational reference that
   * RESOLVES to a cataloged entity uses entity_name directly (enrich path);
   * this field rides only on genuinely NEW entities, seeding the relation
   * into the minted row's state.
   */
  related_to_entity: nullableOptionalString,
  /**
   * §5.4 correction semantics (M2 C3): true when this fact CORRECTS
   * established material — the player is retiring something wrong, not
   * adding something new ("actually, she died of fever, not the plague").
   * An entity-bound correction routes the enrich path through a revise
   * judgment (full block in, clean block out) instead of append; a
   * correction matching a critical fact tombstones-and-replaces it.
   * Deliberate correction is PLAYER AUTHORITY — never clarify it away;
   * clarify remains only for ACCIDENTAL-looking direct contradictions.
   */
  corrects_existing: z.preprocess((v) => (v === null ? undefined : v), z.boolean().default(false)),
  /**
   * The verbatim established text this correction retires, when the
   * extractor can quote it (a dossier block line or a critical fact).
   * Optional — the revise judgment works from the full block regardless.
   */
  supersedes: nullableOptionalString,
});

export const IngestionExtraction = z.object({ facts: z.array(ExtractedFact).default([]) });
export type IngestionExtraction = z.infer<typeof IngestionExtraction>;

export const EXTRACTOR_SYSTEM = [
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
  "RELATIONAL RESOLUTION (§5.4 dossier): the assertion often names an entity by",
  "its RELATION — 'my mother', 'your master', 'the twelve'. Resolve it against",
  "the CAMPAIGN DOSSIER below. If that entity is ALREADY cataloged, set",
  "entity_name to its EXACT dossier name — this enriches the one existing row;",
  "never mint a parallel. ONLY when the relation names a GENUINELY NEW entity do",
  "you give it a fresh descriptive entity_name AND set related_to_entity to the",
  "EXACT dossier name of the anchor it hangs off (a newly-revealed 'The",
  "Monster's Master' hangs off the monster's cataloged name). Likewise BIND to a",
  "live THREAD when the assertion extends one: reuse that thread's exact name",
  "rather than opening a parallel thread.",
  "",
  "CORRECTION (§5.4, player authority — the highest law): when the player",
  "DELIBERATELY retires established material — 'actually…', 'no — it was…',",
  "'she died of fever, not the plague', or any explicit overwrite of something",
  "the dossier or critical facts already assert — that is accept WITH",
  "corrects_existing=true. Quote the exact established text being retired in",
  "supersedes (the dossier block line or the critical fact) whenever you can see",
  "it. Reserve corrects_existing for genuine retirement of something now WRONG —",
  "ordinary new detail that merely adds to the record is a plain accept, not a",
  "correction. A deliberate correction is the player rewriting canon; it is NEVER",
  "clarified away.",
  "",
  "POSTURE is the editor's stance (§5.4):",
  "- accept (DEFAULT, the overwhelming majority): the player authored canon.",
  "  Take it as true. Player words outrank the engine's inference.",
  "- clarify: ONLY for a genuine LOCAL PHYSICAL ambiguity (which of two",
  "  established places did they mean?) or an ACCIDENTAL-looking direct",
  "  contradiction of an established critical fact (the player seems not to",
  "  realize they've crossed canon). A DELIBERATE correction is never clarified",
  "  — it is accept + corrects_existing. Set posture_reason to the SINGLE plain",
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

const RevisedBlock = z.object({ revised_block: z.string() });

export const REVISE_SYSTEM = [
  "You are the record-keeper for a collaborative story engine. A player has",
  "CORRECTED established canon. Their word is PLAYER AUTHORITY (confidence 1) and",
  "the living dossier block must OBEY it — the record changes, it does not merely",
  "acquire a contradiction beside the error.",
  "",
  "Return the block rewritten so that:",
  "- the material the correction contradicts is RETIRED — gone, not annotated;",
  "  leaving the wrong fact next to the right one is a FAILURE;",
  "- the corrected fact is integrated exactly WHERE the retired material stood,",
  "  in the block's own voice;",
  "- EVERY other line survives VERBATIM — same wording, same order. Do not",
  "  reword, reorder, summarize, condense, or add anything the correction did",
  "  not assert.",
  "",
  "You are not an editor improving prose; you are the record obeying one",
  "correction and changing nothing else. When a specific line is named as the one",
  "being retired, retire exactly that line and leave the rest untouched.",
].join(" ");

/**
 * §5.4 correction semantics (M2 C3): the revise judgment. A corrects_existing
 * fact that resolves to a cataloged entity routes here instead of the
 * dedup-append: the FULL current block plus the correction go in, a clean
 * block comes out. Conservative by contract — change ONLY what the correction
 * touches; every non-target line survives verbatim (the acceptance test
 * asserts it). Judgment tier; the caller writes the version row.
 *
 * Code disposes: the output is sanity-gated before it is trusted — an empty
 * block, or one that fails to preserve at least half of the original's
 * non-target lines verbatim, is rejected (throw), and the caller falls back to
 * a plain append so the player's fact is never lost.
 */
export async function reviseBlock(
  selection: TierSelection,
  args: {
    campaignId: string;
    turnNumber: number;
    entityName: string;
    currentBlock: string;
    correction: string;
    /** The verbatim text being retired, when the extractor quoted it. */
    supersedes?: string;
  },
): Promise<{ revisedBlock: string }> {
  const supersedes = args.supersedes?.trim();
  const parts = [
    `ENTITY: ${args.entityName}`,
    "",
    "CURRENT BLOCK (verbatim):",
    args.currentBlock,
    "",
  ];
  if (supersedes) {
    parts.push(
      `THE LINE BEING RETIRED (retire exactly this; the correction takes its place):\n${supersedes}`,
      "",
    );
  }
  parts.push(
    `THE PLAYER'S CORRECTION (player authority, confidence 1):\n${args.correction}`,
    "",
    "Return the full revised block: retire only what the correction contradicts; keep every other line verbatim, in the same order.",
  );

  const { revised_block } = await callJudgment(selection, {
    name: "block_revise",
    schema: RevisedBlock,
    campaignId: args.campaignId,
    turnNumber: args.turnNumber,
    system: REVISE_SYSTEM,
    prompt: parts.join("\n"),
    // Blocks run < 2k chars; STRUCTURED_SMALL is generous for a full rewrite.
    maxTokens: STRUCTURED_SMALL,
  });

  const revised = revised_block.trim();
  if (!revised || revised.length < 10) {
    throw new Error("reviseBlock: model returned an empty or degenerate block");
  }
  // Gross-addition cap (audit #4): the gate below guards deletion, not
  // addition — this blocks wholesale hallucination without policing wording.
  const grossCeiling = args.currentBlock.length + args.correction.length * 2 + 200;
  if (revised.length > grossCeiling) {
    throw new Error(
      `reviseBlock: sanity gate — revision grew ${revised.length} chars vs ceiling ${grossCeiling}`,
    );
  }

  // Non-target lines = the original block's lines minus AT MOST ONE line the
  // correction retires (a correction retires ONE line by contract — a generic
  // supersedes matching many lines must not strip them all of protection,
  // audit #1); at least half must survive VERBATIM or the rewrite is a gutting.
  const originalLines = args.currentBlock
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const targetIndex = supersedes
    ? originalLines.findIndex((l) => normalizedContains(l, supersedes))
    : -1;
  const nonTarget = originalLines.filter((_, i) => i !== targetIndex);
  const survivors = nonTarget.filter((l) => revised.includes(l)).length;
  if (nonTarget.length > 0 && survivors < nonTarget.length / 2) {
    throw new Error(
      `reviseBlock: sanity gate — only ${survivors}/${nonTarget.length} non-target lines survived verbatim`,
    );
  }

  return { revisedBlock: revised };
}

/** Total catalog entities rendered into the dossier before truncation (§5.4 C2). */
const DOSSIER_ENTITY_CAP = 30;
/** Per-entity one-line block head budget (~100 chars). */
const DOSSIER_BLOCK_HEAD_CHARS = 100;

/** The catalog shape the dossier renders — a row plus its age proxy (turnId). */
export interface DossierEntity {
  name: string;
  entityType: string;
  block: string;
  turnId: number;
  /** Entity state jsonb — carries the C4 self-insert protagonist marker. */
  state?: unknown;
}

function blockHead(block: string): string {
  const flat = block.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > DOSSIER_BLOCK_HEAD_CHARS
    ? `${flat.slice(0, DOSSIER_BLOCK_HEAD_CHARS).trimEnd()}…`
    : flat;
}

/**
 * The context dossier (§5.4 C2): "knowing what to do with that assertion
 * requires context of the campaign so far — what npcs exist already, what arcs
 * or threads are active" (user requirement). Entities render with one-line
 * block heads, grouped — the PLAYER'S PROTAGONIST first (the premise's second
 * pole), then npcs/factions/locations, then THREADS as their own group (the
 * Director's live material the extractor must extend, not fork). The active arc
 * line rides on top when present.
 *
 * Bounded (§0.9, no silent caps): protagonist + threads are always included;
 * the rest fill the remaining budget most-recent-first by turnId, and a
 * truncation warns rather than silently dropping catalog.
 */
export function renderDossier(
  entityRows: DossierEntity[],
  arcLine: string | undefined,
  turnNumber: number,
): string {
  // The state marker first (M2R R4 audit — the C4 fix pattern): a REAL-named
  // PC must group under THE PLAYER'S PROTAGONIST, not file under NPCS and
  // fall off the recency budget (its row keeps turnId 0 forever).
  const isProt = (e: DossierEntity) =>
    e.entityType === "npc" && (marksPlayerProtagonistState(e.state) || isProtagonistName(e.name));
  const protagonist = entityRows.filter(isProt);
  const threads = entityRows.filter((e) => e.entityType === "thread");
  const others = entityRows
    .filter((e) => !isProt(e) && e.entityType !== "thread")
    .sort((a, b) => b.turnId - a.turnId);

  const budget = Math.max(0, DOSSIER_ENTITY_CAP - protagonist.length - threads.length);
  const keptOthers = others.slice(0, budget);
  if (others.length > keptOthers.length) {
    console.warn(
      `[ingestion] dossier truncated at ${DOSSIER_ENTITY_CAP}: dropped ${others.length - keptOthers.length} of ${others.length} non-thread entities (turn ${turnNumber})`,
    );
  }

  const line = (e: DossierEntity) => {
    const head = blockHead(e.block);
    return head ? `- ${e.name}: ${head}` : `- ${e.name}`;
  };
  const group = (label: string, rows: DossierEntity[]) =>
    rows.length > 0 ? `${label}:\n${rows.map(line).join("\n")}` : "";

  const npcs = keptOthers.filter((e) => e.entityType === "npc");
  const factions = keptOthers.filter((e) => e.entityType === "faction");
  const locations = keptOthers.filter((e) => e.entityType === "location");
  const misc = keptOthers.filter(
    (e) => e.entityType !== "npc" && e.entityType !== "faction" && e.entityType !== "location",
  );

  const sections = [
    arcLine ? `ACTIVE ARC: ${arcLine}` : "",
    group("THE PLAYER'S PROTAGONIST", protagonist),
    group("NPCS", npcs),
    group("FACTIONS", factions),
    group("LOCATIONS", locations),
    group("OTHER ENTITIES", misc),
    group("THREADS (the Director's live material — extend these, do not fork parallels)", threads),
  ].filter(Boolean);

  if (sections.length === 0) return "CAMPAIGN DOSSIER: (empty — no catalog yet)";
  return `CAMPAIGN DOSSIER (resolve relational references to these EXACT names):\n\n${sections.join("\n\n")}`;
}

/**
 * The extractor's per-call prompt (§5.4 pipeline step 1): established critical
 * facts (the clarify anchor), the campaign dossier, then the player assertion.
 * Exported so the C2 acceptance eval builds the byte-identical prompt the
 * runtime extractor sees.
 */
export function buildExtractorPrompt(args: {
  criticalFacts: string[];
  entityRows: DossierEntity[];
  arcLine?: string;
  turnNumber: number;
  text: string;
}): string {
  return [
    args.criticalFacts.length > 0
      ? `ESTABLISHED CRITICAL FACTS (an ACCIDENTAL contradiction is a reason to clarify; a DELIBERATE correction of one of these is accept + corrects_existing, quoting it in supersedes):\n${args.criticalFacts.map((c) => `- ${c}`).join("\n")}`
      : "ESTABLISHED CRITICAL FACTS: (none yet)",
    renderDossier(args.entityRows, args.arcLine, args.turnNumber),
    "",
    `PLAYER ASSERTION:\n${args.text}`,
  ].join("\n");
}

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
  opts: {
    profileIds: string[];
    provenance?: string;
    /** §5.4 dossier (M2 C2): the active arc line ("name — dramatic question"),
     *  passed by the turn path (layout has it in hand; SZ has no arc yet). */
    arcLine?: string;
  },
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
      .select({
        id: criticalFacts.id,
        content: criticalFacts.content,
        category: criticalFacts.category,
      })
      .from(criticalFacts)
      .where(and(eq(criticalFacts.campaignId, campaignId), notTombstoned(criticalFacts))),
    db
      .select({
        id: entities.id,
        name: entities.name,
        entityType: entities.entityType,
        block: entities.block,
        turnId: entities.turnId,
        // §6.5/M2 C4: the self-insert marker registers the protagonist sentinel
        // for a REAL-named PC row (isProtagonistName misses "Kaelen").
        state: entities.state,
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
    prompt: buildExtractorPrompt({
      criticalFacts: criticalRows.map((c) => c.content),
      entityRows,
      arcLine: opts.arcLine,
      turnNumber,
      text,
    }),
    maxTokens: STRUCTURED_SMALL,
  });

  const writes: IngestedWrite[] = [];
  const flags: string[] = [];
  const clarifyQuestions: string[] = [];
  // §5.4 correction (M2 C3): critical facts already tombstoned-and-replaced this
  // assertion, so a second fact can't double-retire the same row.
  const tombstonedCriticalIds = new Set<string>();

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
    // The sentinel binds every protagonist spelling to the one PC row. A row the
    // SZ compiler marked as the player's self-insert (state) registers it even
    // when its NAME is real ("Kaelen") — otherwise C4's named PC re-opens the
    // turn-3 dupe hole this guard exists to close (M2 C4).
    if (
      e.entityType === "npc" &&
      (marksPlayerProtagonistState(e.state) || isProtagonistName(e.name))
    )
      catalog.set(PROTAGONIST_KEY, e);
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

  // The entity's next version number — every block mutation (enrich or revise)
  // stacks a new row so a rewind can restore any prior state.
  const nextVersion = async (entityId: string): Promise<number> => {
    const [{ maxVersion } = { maxVersion: null }] = await db
      .select({ maxVersion: sql<number | null>`max(${entityVersions.version})` })
      .from(entityVersions)
      .where(eq(entityVersions.entityId, entityId));
    return (maxVersion ? Number(maxVersion) : 0) + 1;
  };

  // Enrich a resolved catalog entity (append + version row) — shared by the
  // deterministic-match path and the semantic mint-guard path.
  const enrichExisting = async (target: EntityRef, content: string): Promise<void> => {
    const newBlock = target.block ? `${target.block}\n- ${content}` : content;
    const version = await nextVersion(target.id);
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

  // §5.4 correction (M2 C3): a corrects_existing fact rewrites the living block
  // instead of appending — the record OBEYS the player's word, and the version
  // row preserves the prior state. Returns false on ANY failure (revise throw,
  // sanity rejection, corrective-retry exhaustion) so the caller falls back to
  // a plain append; the fact is never lost.
  const reviseExisting = async (
    target: EntityRef,
    fact: (typeof writable)[number],
  ): Promise<boolean> => {
    try {
      const { revisedBlock } = await reviseBlock(selection, {
        campaignId,
        turnNumber,
        entityName: target.name,
        currentBlock: target.block,
        correction: fact.content,
        ...(fact.supersedes?.trim() ? { supersedes: fact.supersedes.trim() } : {}),
      });
      const version = await nextVersion(target.id);
      await db.update(entities).set({ block: revisedBlock }).where(eq(entities.id, target.id));
      await db
        .insert(entityVersions)
        .values({ entityId: target.id, version, block: revisedBlock, ...envelope });
      target.block = revisedBlock;
      const head = revisedBlock.replace(/\s+/g, " ").trim().slice(0, 80);
      writes.push({
        kind: "entity_revised",
        id: target.id,
        summary: `Corrected ${target.entityType} "${target.name}": ${head}`,
      });
      return true;
    } catch (err) {
      console.warn(
        `[ingestion] reviseBlock failed for "${target.name}" (turn ${turnNumber}): ${err}`,
      );
      return false;
    }
  };

  // §4.7/§6.5 voice-card stamp (M2 C8): when a speaking-cast entity links to
  // canon below, the matching profile voice card rides its state so the KA
  // hears the character. Profiles load once, lazily (only when a canon-linked
  // NPC actually needs a card), keyed by profile; the match is identityKey
  // equality against the card's character name (semantic name-matching is out
  // of scope, same discipline as the deterministic identity tier).
  let voiceCardsByProfile: Map<string, z.infer<typeof VoiceCard>[]> | undefined;
  const voiceCardFor = async (
    profileId: string,
    entityName: string,
  ): Promise<string | undefined> => {
    if (!voiceCardsByProfile) {
      voiceCardsByProfile = new Map();
      if (opts.profileIds.length > 0) {
        const rows = await db
          .select({ id: profiles.id, profile: profiles.profile })
          .from(profiles)
          .where(inArray(profiles.id, opts.profileIds));
        for (const r of rows) {
          const parsed = ProfileVoiceCards.safeParse(r.profile);
          voiceCardsByProfile.set(r.id, parsed.success ? parsed.data.ip_mechanics.voice_cards : []);
        }
      }
    }
    const key = identityKey(entityName);
    if (!key) return undefined;
    const card = voiceCardsByProfile.get(profileId)?.find((c) => identityKey(c.name) === key);
    return card ? voiceCardFingerprint(card) : undefined;
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
        // §5.4 correction: a corrects_existing fact rewrites the living block
        // (the record obeys); a failed revision falls back to append so the
        // fact is never lost, with a flag for the Director to reconcile.
        if (fact.corrects_existing) {
          const revised = await reviseExisting(existing, fact);
          if (!revised) {
            await enrichExisting(existing, fact.content);
            flags.push(
              "A player correction could not be applied cleanly — appended instead; the Director should reconcile.",
            );
          }
        } else {
          await enrichExisting(existing, fact.content);
        }
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
        // §5.4 relational consumption (M2 C2): a genuinely NEW entity defined by
        // its relation to a cataloged anchor ("The Monster's Master" → the
        // monster) seeds that relation into state, matching G1's turn-keyed
        // relationships shape. An unresolvable anchor is ignored — the relation
        // text still lives in the block/content.
        const anchorName = fact.related_to_entity?.trim();
        const anchor = anchorName ? lookupEntity(anchorName) : undefined;
        // §4.7/§6.5 (M2 C8): a speaking-cast (npc) row that linked to canon
        // inherits its profile voice card. Only the canon-link mint carries it —
        // the SZ compiler's brief admission does not link canon, so this ingest
        // site is the single writer.
        const voiceCard =
          resolved && entityType === "npc"
            ? await voiceCardFor(resolved.profileId, name)
            : undefined;
        const state: Record<string, unknown> = {};
        if (anchor) {
          state.relationships = {
            [String(turnNumber)]: `related to ${anchor.name}: ${fact.content.slice(0, 120).trim()}`,
          };
        }
        if (voiceCard) state.voice_card = voiceCard;
        const [created] = await db
          .insert(entities)
          .values({
            campaignId,
            name,
            entityType,
            block,
            ...(Object.keys(state).length > 0 ? { state } : {}),
            ...envelope,
          })
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

    // §5.4 critical-fact correction (M2 C3): a corrects_existing fact whose
    // supersedes (or, absent that, its content) matches an established critical
    // fact tombstones that row and inserts the replacement — the substrate's own
    // idiom (never a silent mutation), and independent of the entity path: a
    // single correction can hit BOTH an entity block and a critical fact.
    // ONE correction retires ONE critical fact (audit #2: a generic needle must
    // not sweep unrelated rows) — first un-retired match, deterministic order.
    if (fact.corrects_existing) {
      const needle = fact.supersedes?.trim() || fact.content;
      const cf = criticalRows.find(
        (row) => !tombstonedCriticalIds.has(row.id) && normalizedContains(row.content, needle),
      );
      if (cf) {
        tombstonedCriticalIds.add(cf.id);
        await db
          .update(criticalFacts)
          .set({ tombstonedAt: new Date() })
          .where(eq(criticalFacts.id, cf.id));
        const [replacement] = await db
          .insert(criticalFacts)
          .values({ campaignId, content: fact.content, category: cf.category, ...envelope })
          .returning({ id: criticalFacts.id });
        if (replacement) {
          writes.push({
            kind: "critical_fact_replaced",
            id: replacement.id,
            summary: `Replaced critical fact: ${fact.content.slice(0, 80)}`,
          });
        }
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
