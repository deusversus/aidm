import type { Db } from "@/lib/db";
import { appendPlayerTaste } from "@/lib/db/helpers";
import {
  campaigns,
  criticalFacts,
  entities,
  entityVersions,
  pencilMarks,
  profiles,
} from "@/lib/db/schema";
import { identityKey, isProtagonistName, marksSelfInsert } from "@/lib/entity-identity";
import { ingestAssertion } from "@/lib/ingestion/ingest";
import { LOOPED_LARGE } from "@/lib/llm/budgets";
import { callJudgment } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import { Composition } from "@/lib/types/composition";
import { DNAScales } from "@/lib/types/dna";
import { OpeningStatePackage } from "@/lib/types/opening";
import {
  Canonicality,
  type PremiseComponents,
  PremiseContract,
  PresentationVocabulary,
  SuggestionAffordance,
} from "@/lib/types/premise";
import { PowerTier, Profile } from "@/lib/types/profile";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import { z } from "zod";
import type { ConductorDraft, Observation } from "./conductor";

/**
 * The Session Zero compiler (blueprint §8): chunked extraction → resolution
 * with merge history → gap verdict (blocking issues halt handoff) →
 * PremiseContract + OpeningStatePackage → persistence. Deterministic
 * everywhere judgment isn't required (axiom 7); the one model call is the
 * OSP synthesis, injectable for tests. Envelopes are ENGINE-stamped — the
 * model never fills provenance.
 */

// Engine-stamped envelope, in both spellings it must wear: the zod contracts
// carry snake_case (`turn_id`); the drizzle insert props are camelCase.
const SZ_STAMP = { provenance: "sz_compiler", confidence: 0.9 };
const SZ_ENVELOPE = { turn_id: 0, ...SZ_STAMP };
const SZ_ROW = { turnId: 0, ...SZ_STAMP };

/** A 'compiling' claim older than this is a crashed compile — re-claimable. */
const STALE_COMPILE_CLAIM_MS = 5 * 60 * 1000;

// --- Resolution: latest-wins per kind (per-axis for calibration) -----------

export interface ResolvedObservations {
  spark?: string;
  finitude?: "finite" | "indefinite" | "undecided";
  /**
   * §8 + M2 C4: the protagonist's name, anchored-first like finitude
   * ("Kaelen — he chose it himself" resolves to "Kaelen"). A content
   * beginning "deferred" is the player's explicit word that the name
   * emerges in play — pcNameDeferred records it; the gap verdict blocks
   * an unnamed, un-deferred protagonist.
   */
  pcName?: string;
  pcNameDeferred: boolean;
  /**
   * SV2: the character concept — seat choice + big idea, the player's own
   * words VERBATIM (never anchored-parsed; it's prose, not an enum). The
   * never-assume-the-canon-seat gate: absent and un-deferred blocks the
   * handoff, same discipline as the name.
   */
  pcConcept?: string;
  pcConceptDeferred: boolean;
  deathPhysics?: string;
  lethalityPosture?: string;
  hardLines: string[];
  controlKey?: string;
  calibration: Partial<Record<keyof DNAScales, number>>;
  canonicality?: Partial<Canonicality>;
  /**
   * SV3 (§8): the chosen starting power tier against the world's baseline.
   * Absent = the player plays at baseline (also the pre-SV3 default). The
   * baseline rides along for OSP context; the contract carries the tier.
   */
  pcPowerTier?: z.infer<typeof PowerTier>;
  pcPowerBaseline?: z.infer<typeof PowerTier>;
  /** SV3: OP-composition moves — active-layer Framing overrides, latest-wins per axis. */
  framingChoices: { axis: keyof Composition; value: string }[];
  presentationGrants: string[];
  suggestionAffordance?: z.infer<typeof SuggestionAffordance>;
  tierSelection?: TierSelection;
  /**
   * Hybrid per-component picks (§4.1: a hybrid is a selection, not an
   * average). Gathered and persisted from C3 on; the per-component contract
   * ASSEMBLY is M4's — see gapVerdict's hybrid block.
   */
  blendChoices: { component: string; choice: string }[];
  worldFacts: Observation[];
  castFacts: Observation[];
  playerTaste: string[];
  deferred: string[];
}

type Finitude = "finite" | "indefinite" | "undecided";

/**
 * Finitude is the sacrosanct Series choice (§8) recorded as free text, and
 * free text can name BOTH words ("finite — they considered indefinite…").
 * Resolution never guesses: the leading word wins (the conductor is told to
 * record it first); otherwise a value resolves only when exactly ONE
 * distinct word appears. Ambiguous records stay unresolved — the gap
 * verdict blocks a guessed contract, it never ships one.
 */
export function resolveFinitude(content: string): Finitude | undefined {
  const anchored = /^\s*["'“‘]?(indefinite|undecided|finite)\b/i.exec(content);
  if (anchored) return anchored[1]?.toLowerCase() as Finitude;
  const hits = new Set<Finitude>();
  if (/\bindefinite(ly)?\b/i.test(content)) hits.add("indefinite");
  if (/\bundecided\b/i.test(content)) hits.add("undecided");
  if (/\bfinite\b/i.test(content)) hits.add("finite");
  return hits.size === 1 ? [...hits][0] : undefined;
}

export function resolveObservations(observations: Observation[]): ResolvedObservations {
  const resolved: ResolvedObservations = {
    pcNameDeferred: false,
    pcConceptDeferred: false,
    hardLines: [],
    calibration: {},
    framingChoices: [],
    presentationGrants: [],
    blendChoices: [],
    worldFacts: [],
    castFacts: [],
    playerTaste: [],
    deferred: [],
  };
  // Deferral notes surface as open items only if still deferred AFTER
  // latest-wins resolution — a player who defers, then decides, must never
  // see a stale "left open" line in the conductor's summary (SV2; the C4
  // name path gains the same discipline).
  let nameDeferralNote: string | undefined;
  let conceptDeferralNote: string | undefined;
  for (const obs of observations) {
    switch (obs.kind) {
      case "spark":
        resolved.spark = obs.content; // verbatim, latest wins
        break;
      case "finitude": {
        const value = resolveFinitude(obs.content);
        if (value) resolved.finitude = value;
        else resolved.deferred.push(`ambiguous finitude: ${obs.content.slice(0, 80)}`);
        break;
      }
      case "pc_name": {
        // Anchored-first, same discipline as finitude: the name (or the word
        // "deferred") leads; color follows a separator. Latest wins — a player
        // who renames mid-conversation gets their newest word.
        const content = obs.content.trim();
        if (/^["'“‘]?deferred\b/i.test(content)) {
          resolved.pcNameDeferred = true;
          resolved.pcName = undefined;
          nameDeferralNote = `protagonist name deferred to play: ${content.slice(0, 80)}`;
        } else {
          let name = content.split(/\s+[—–-]\s|\n/)[0]?.trim() ?? "";
          // Sentence-period color cuts, but honorifics survive: a ". " only
          // terminates the name when the word before it is ≥4 chars — so
          // "Kaelen. He chose it" cuts and "Dr. Elara Voss" / "Lt. Col. Roy
          // Mustang" stay whole (C4 audit #2).
          for (const m of name.matchAll(/(\S+)\.\s/g)) {
            const word = (m[1] ?? "").replace(/[^A-Za-z'’]/g, "");
            if (word.length >= 4 && m.index !== undefined) {
              name = name.slice(0, m.index + (m[1] ?? "").length);
              break;
            }
          }
          // Strip wrapping quotes only — internal apostrophes are part of the
          // name (Ka'el stays Ka'el, either apostrophe form; C4 audit #4).
          name = name.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
          if (name) {
            resolved.pcName = name;
            resolved.pcNameDeferred = false;
          }
        }
        break;
      }
      case "pc_concept": {
        // Verbatim, latest-wins — the concept is prose, never parsed. Only
        // the deferral sentinel is anchored, same form as pc_name.
        const content = obs.content.trim();
        if (/^["'“‘]?deferred\b/i.test(content)) {
          resolved.pcConceptDeferred = true;
          resolved.pcConcept = undefined;
          conceptDeferralNote = `character concept deferred to play: ${content.slice(0, 80)}`;
        } else if (content) {
          resolved.pcConcept = content;
          resolved.pcConceptDeferred = false;
        }
        break;
      }
      case "death_physics":
        resolved.deathPhysics = obs.content;
        break;
      case "lethality_posture":
        resolved.lethalityPosture = obs.content;
        break;
      case "hard_line":
        resolved.hardLines.push(obs.content);
        break;
      case "control_key": {
        // §7.5: NO key exists unless the player CUTS one. A recorded
        // declination (anchored "declined", same discipline as finitude)
        // compiles to no key — the raw decline stays in the observation
        // record so nobody re-asks, but the contract never wears it as a
        // cut key (live defect: a "Declined — ..." circumstance rendered
        // the Settei's bounded-permission block around a refusal).
        // Latest wins both ways: decline-then-cut keeps the cut;
        // cut-then-decline melts it.
        if (/^\s*["'“‘]?declined\b/i.test(obs.content)) {
          resolved.controlKey = undefined;
        } else {
          resolved.controlKey = obs.content;
        }
        break;
      }
      case "calibration": {
        try {
          const parsed = z
            .object({ axis: z.string(), value: z.number().min(0).max(10) })
            .parse(JSON.parse(obs.content));
          if (parsed.axis in DNAScales.shape) {
            resolved.calibration[parsed.axis as keyof DNAScales] = parsed.value;
          }
        } catch {
          resolved.deferred.push(`unparseable calibration: ${obs.content.slice(0, 80)}`);
        }
        break;
      }
      case "pc_power_tier": {
        try {
          const parsed = z
            .object({ tier: PowerTier, baseline: PowerTier.optional() })
            .parse(JSON.parse(obs.content));
          resolved.pcPowerTier = parsed.tier;
          resolved.pcPowerBaseline = parsed.baseline;
        } catch {
          resolved.deferred.push(`unparseable power tier: ${obs.content.slice(0, 80)}`);
        }
        break;
      }
      case "framing_choice": {
        // Calibration's idiom for the Framing component: any of the 13 axes,
        // the value validated against THAT axis's enum — the model proposes,
        // the schema disposes. Latest wins per axis.
        try {
          const parsed = z
            .object({ axis: z.string(), value: z.string() })
            .parse(JSON.parse(obs.content));
          const axisSchema =
            parsed.axis in Composition.shape
              ? Composition.shape[parsed.axis as keyof Composition]
              : undefined;
          if (axisSchema?.safeParse(parsed.value).success) {
            resolved.framingChoices = [
              ...resolved.framingChoices.filter((f) => f.axis !== parsed.axis),
              { axis: parsed.axis as keyof Composition, value: parsed.value },
            ];
          } else {
            resolved.deferred.push(`unrecognized framing choice: ${obs.content.slice(0, 80)}`);
          }
        } catch {
          resolved.deferred.push(`unparseable framing choice: ${obs.content.slice(0, 80)}`);
        }
        break;
      }
      case "canonicality": {
        try {
          resolved.canonicality = {
            ...resolved.canonicality,
            ...Canonicality.partial().parse(JSON.parse(obs.content)),
          };
        } catch {
          // Prose canonicality notes become accepted-divergence text.
          resolved.canonicality = {
            ...resolved.canonicality,
            accepted_divergences: [
              ...(resolved.canonicality?.accepted_divergences ?? []),
              obs.content,
            ],
          };
        }
        break;
      }
      case "blend": {
        try {
          const parsed = z
            .object({ component: z.string().min(1), choice: z.string().min(1) })
            .parse(JSON.parse(obs.content));
          // Latest wins per component.
          resolved.blendChoices = [
            ...resolved.blendChoices.filter((b) => b.component !== parsed.component),
            parsed,
          ];
        } catch {
          resolved.deferred.push(`unparseable blend choice: ${obs.content.slice(0, 80)}`);
        }
        break;
      }
      case "presentation":
        resolved.presentationGrants.push(obs.content);
        break;
      case "suggestion_affordance": {
        // Same discipline as resolveFinitude — enum tokens appear inside prose
        // ("…never as a fourth-wall voice" compiled to "never", live
        // 2026-07-10). Anchored value wins; a unique whole-token hit resolves;
        // anything else defers to the safe default and says so.
        const text = obs.content.toLowerCase();
        const anchored = SuggestionAffordance.options.find((o) =>
          new RegExp(`^\\s*["'“‘]?${o}\\b`).test(text),
        );
        // "never" is everyday prose (the live misparse) — it only counts
        // anchored. The snake_case tokens can't occur naturally, so a unique
        // unanchored hit of those still resolves.
        const hits = SuggestionAffordance.options.filter(
          (o) => o !== "never" && new RegExp(`\\b${o}\\b`).test(text),
        );
        const value = anchored ?? (hits.length === 1 ? hits[0] : undefined);
        if (value) {
          resolved.suggestionAffordance = value;
        } else {
          resolved.suggestionAffordance = "on_request_only";
          resolved.deferred.push(`ambiguous suggestion affordance: ${obs.content.slice(0, 80)}`);
        }
        break;
      }
      case "tier_selection": {
        try {
          const parsed = TierSelection.safeParse(JSON.parse(obs.content));
          if (parsed.success) resolved.tierSelection = parsed.data;
          else resolved.deferred.push(`unparseable tier selection: ${obs.content.slice(0, 80)}`);
        } catch {
          resolved.deferred.push(`unparseable tier selection: ${obs.content.slice(0, 80)}`);
        }
        break;
      }
      case "world_fact":
        resolved.worldFacts.push(obs);
        break;
      case "cast_fact":
        resolved.castFacts.push(obs);
        break;
      case "player_taste":
        resolved.playerTaste.push(obs.content);
        break;
      case "deferred":
        resolved.deferred.push(obs.content);
        break;
    }
  }
  if (resolved.pcNameDeferred && nameDeferralNote) resolved.deferred.push(nameDeferralNote);
  if (resolved.pcConceptDeferred && conceptDeferralNote)
    resolved.deferred.push(conceptDeferralNote);
  return resolved;
}

// --- Gap verdict (deterministic, blocking) ----------------------------------

export function gapVerdict(resolved: ResolvedObservations, hasProfile: boolean): string[] {
  const gaps: string[] = [];
  if (!hasProfile) gaps.push("no researched profile — the World never loaded");
  if (!resolved.spark) gaps.push("the spark was never gathered (§8's one mandatory question)");
  if (!resolved.finitude) gaps.push("finitude undetermined — the Series contract is sacrosanct");
  if (!resolved.pcName && !resolved.pcNameDeferred)
    gaps.push(
      "the protagonist is unnamed and the player has not deferred it — ask, or record their explicit deferral (M2 C4)",
    );
  if (!resolved.pcConcept && !resolved.pcConceptDeferred)
    gaps.push(
      "the character's concept was never gathered and the player has not deferred it — who are they in this? Ask for the big idea, or record their explicit deferral (SV2)",
    );
  if (!resolved.deathPhysics) gaps.push("death physics ungathered (intensity contract)");
  if (!resolved.lethalityPosture) gaps.push("lethality posture ungathered (intensity contract)");
  if (!resolved.tierSelection)
    gaps.push("no tier selection — the player picks the models, never the engine");
  return gaps;
}

// --- OSP synthesis (the one model call; injectable) --------------------------

/** Model-facing OSP: content only — the compiler stamps every envelope. */
const OspDraft = z.object({
  director_inputs: z.object({
    opening_situation: z.string(),
    spark_reading: z.string(),
    suggested_first_arc_question: z.string(),
  }),
  animation_inputs: z.object({
    forbidden_opening_moves: z.array(z.string()),
    opening_pov: z.string(),
  }),
  constraints: z.array(z.object({ text: z.string(), tier: z.enum(["hard", "soft"]) })),
  uncertainties: z.array(
    z.object({
      question: z.string(),
      safe_assumption: z.string(),
      degraded_generation_guidance: z.string(),
    }),
  ),
  briefs: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["cast", "world", "faction", "thread"]),
      brief: z.string(),
      admit_to_catalog: z.boolean(),
    }),
  ),
  orphan_facts: z.array(z.string()),
});

export type OspSynthesizer = (input: {
  campaignId: string;
  title: string;
  spark: string;
  resolved: ResolvedObservations;
  directorPersonality: string;
}) => Promise<z.infer<typeof OspDraft>>;

export const defaultOspSynthesizer: OspSynthesizer = async ({
  campaignId,
  title,
  spark,
  resolved,
  directorPersonality,
}) => {
  // The player's judgment tier drives the compile (their pick, never the
  // engine's); the gap verdict guarantees it exists by the time this runs.
  return callJudgment(resolved.tierSelection ?? DEV_TIER_SELECTION, {
    name: "sz_compile_osp",
    campaignId,
    schema: OspDraft,
    system: [
      "You compile Session Zero's Opening State Package for a story engine.",
      "Constraints: hard = inviolable (player hard lines, world physics);",
      "soft = strong preferences. Uncertainties are things the conversation",
      "left OPEN — state them with a safe assumption and guidance for",
      "writing AROUND them without foreclosing (never resolve them).",
      "RECONCILE before writing an uncertainty: if a recorded fact answers",
      "the question, it is NOT an uncertainty — never resurrect what the",
      "conversation resolved. When an open question sits NEXT TO a resolved",
      "one, the question text must state what IS known so the two cannot be",
      "confused (e.g. 'the mechanism is recorded; the ORIGIN is not').",
      "forbidden_opening_moves protect the cold open (no premature reveals,",
      "no spending the spark in scene one). Briefs are seeds for the entity",
      "layer: ONE brief per underlying entity — a role reference ('Mother')",
      "and a proper name are the same person; merge under the best canonical",
      "name with aliases noted in the brief. admit_to_catalog=true only for",
      "entities certain to persist.",
      "Orphan facts: anything true that fits nowhere — keep, never drop.",
    ].join(" "),
    prompt: [
      `Title: ${title}`,
      `Director personality: ${directorPersonality}`,
      // M2 C4: the protagonist's name (the premise's second pole) reaches the
      // OSP so briefs and the opening use it; a deferral tells the synthesizer
      // NOT to invent one.
      `Protagonist (the player's character): ${
        resolved.pcName ??
        (resolved.pcNameDeferred
          ? "(name deferred to play — do NOT invent one; refer to them by role)"
          : "(unnamed)")
      }`,
      // SV2: the concept (seat + big idea, the player's own words) anchors the
      // protagonist brief and the Director inputs; a deferral tells the
      // synthesizer the character EMERGES — never pre-shape them.
      `Character concept (verbatim): ${
        resolved.pcConcept ??
        (resolved.pcConceptDeferred
          ? "(deferred to play — do NOT invent one; let the character emerge)"
          : "(not gathered)")
      }`,
      `THE SPARK (verbatim): ${spark}`,
      `Finitude: ${resolved.finitude}`,
      // SV3: the chosen tier shapes the opening — an OP protagonist must not
      // get a struggle-scene cold open the premise already outgrew.
      `Power tier: ${
        resolved.pcPowerTier
          ? `${resolved.pcPowerTier} chosen against world baseline ${resolved.pcPowerBaseline ?? "(profile typical)"}`
          : "(world baseline — no elevated tier chosen)"
      }`,
      `Death physics: ${resolved.deathPhysics}`,
      `Lethality: ${resolved.lethalityPosture}`,
      `Hard lines: ${resolved.hardLines.join("; ") || "(none)"}`,
      `Control key: ${resolved.controlKey ?? "(not on the table)"}`,
      `Blend decisions: ${resolved.blendChoices.map((b) => `${b.component} ← ${b.choice}`).join("; ") || "(single source)"}`,
      `World facts: ${resolved.worldFacts.map((o) => o.content).join("; ") || "(none)"}`,
      `Cast facts: ${resolved.castFacts.map((o) => o.content).join("; ") || "(none)"}`,
      `Deferred (Director's territory — likely uncertainties): ${resolved.deferred.join("; ") || "(none)"}`,
    ].join("\n"),
    effort: "high",
    // OSP synthesis emits a large contract; thinking headroom is added
    // structurally (computeEffectiveMaxTokens). Ceiling, not target.
    maxTokens: LOOPED_LARGE,
  });
};

// --- Compile-time catalog dedup (§6.5: one entity per campaign+type+identity)-
// The DB unique index is EXACT (campaign, type, name); near-duplicate briefs
// slip it, so overlapping admissions are collapsed HERE, deterministically,
// before insert. LIMIT (deterministic only): DIFFERENT names meaning the same
// thing ("Lloyd and protagonist connection" vs "Path-Crossing with Lloyd") are
// M2 semantic-alias territory — left as separate rows, never guessed together.

type BriefKind = "cast" | "world" | "faction" | "thread";
type CatalogEntityType = "npc" | "faction" | "location" | "thread";

function entityTypeForBriefKind(kind: BriefKind): CatalogEntityType {
  return kind === "cast"
    ? "npc"
    : kind === "faction"
      ? "faction"
      : kind === "world"
        ? "location"
        : "thread";
}

/**
 * Canonical identity key for the near-duplicate merge: lowercased, apostrophes
 * dropped (so "player's" ≡ "players"), punctuation → single spaces, trimmed.
 * Word boundaries survive — this is equality, not fuzzy matching.
 */
/** Capability material sorts AFTER identity material in the merged protagonist
 *  block (§6.5: identity first, then what they can do). */
const CAPABILITY_RE =
  /\b(abilit\w*|powers?|skills?|wields?|combat|magic\w*|weapons?|spells?|prowess|fighter|fights?|strength|techniques?|arsenal)\b/i;

interface AdmitBrief {
  name: string;
  kind: BriefKind;
  brief: string;
}
export interface CatalogAdmission {
  name: string;
  entityType: CatalogEntityType;
  block: string;
  /**
   * M2 C4: the self-insert protagonist row is stamped with a durable state
   * marker so the ingestion resolver aliases "the protagonist" to it even when
   * it carries a REAL name (isProtagonistName misses "Kaelen"). The compile's
   * admission insert reads this to write `state.is_player_protagonist`.
   */
  isPlayerProtagonist?: boolean;
}

/**
 * Collapse overlapping catalog admissions before insert (§6.5 identity guard):
 *   a. self-insert protagonist briefs — matched by placeholder NAME or by a
 *      self-insert DESCRIPTION — fold into ONE npc, identity material first and
 *      capability material after; the survivor keeps a real extracted name if
 *      one exists, else "The Protagonist".
 *   b. remaining briefs sharing an entityType AND an equal normalized name
 *      merge into one row (the exact-name index misses these near-duplicates).
 * Insertion order is preserved (Map iteration order). This is the whole of the
 * deterministic fix — semantic aliasing across DIFFERENT names is out of scope.
 *
 * `pcName` (M2 C4): the player's resolved protagonist name flows in from Session
 * Zero and NAMES the merged self-insert row exactly — a real extracted name is
 * the fallback, and "The Protagonist" only when the name was deferred. The
 * change is additive; existing callers pass no pcName and keep prior behavior.
 */
export function dedupeAdmissions(
  admitted: AdmitBrief[],
  pcName?: string,
  opts: { nameDeferred?: boolean } = {},
): CatalogAdmission[] {
  const PROTAGONIST_KEY = "npc::#protagonist#";
  interface Group {
    entityType: CatalogEntityType;
    realName?: string;
    blocks: { text: string; capability: boolean }[];
  }
  const groups = new Map<string, Group>();
  let noKeyCounter = 0;
  for (const b of admitted) {
    const entityType = entityTypeForBriefKind(b.kind);
    const placeholder = isProtagonistName(b.name) || marksSelfInsert(b.name);
    const isProtagonist = entityType === "npc" && (placeholder || marksSelfInsert(b.brief));
    // Empty-normalization guard (§6.5, M2 C1): an all-punctuation name ("???")
    // normalizes to "" — give each its own key so two such names stay distinct
    // rows instead of collapsing on the shared empty key (M1-audit note).
    const idKey = identityKey(b.name);
    const key = isProtagonist
      ? PROTAGONIST_KEY
      : idKey
        ? `${entityType}::${idKey}`
        : `${entityType}::#nokey#${noKeyCounter++}`;
    let group = groups.get(key);
    if (!group) {
      group = { entityType, blocks: [] };
      groups.set(key, group);
    }
    // A real extracted name claims the survivor slot; a placeholder never does.
    if (!(isProtagonist && placeholder)) group.realName ??= b.name;
    group.blocks.push({ text: b.brief, capability: CAPABILITY_RE.test(b.brief) });
  }
  return [...groups.entries()].map(([key, group]) => {
    if (key === PROTAGONIST_KEY) {
      const identity = group.blocks.filter((x) => !x.capability).map((x) => x.text);
      const capability = group.blocks.filter((x) => x.capability).map((x) => x.text);
      return {
        // The player's word (pcName) names the row; a real extracted name is
        // the fallback. An EXPLICIT deferral overrides everything — the OSP is
        // told not to invent a name, but a smuggled brief name must not win
        // over the player's word either (C4 audit #1: code disposes).
        name: opts.nameDeferred
          ? "The Protagonist"
          : (pcName ?? group.realName ?? "The Protagonist"),
        entityType: "npc" as const,
        block: [...identity, ...capability].join("\n\n"),
        isPlayerProtagonist: true,
      };
    }
    return {
      name: group.realName ?? "",
      entityType: group.entityType,
      block: group.blocks.map((x) => x.text).join("\n\n"),
    };
  });
}

// --- Compile -----------------------------------------------------------------

export interface CompileResult {
  contract: PremiseContract;
  opening: OpeningStatePackage;
  gaps: string[];
}

/** The §5.4 ingestion seam, injectable for tests (like the OSP synthesizer). */
export type Ingestor = typeof ingestAssertion;

export async function compileSessionZero(
  db: Db,
  campaignId: string,
  opts: { ospSynthesizer?: OspSynthesizer; ingestor?: Ingestor } = {},
): Promise<CompileResult> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) throw new Error("campaign not found");
  const draft = campaign.szTranscript as ConductorDraft | null;
  if (!draft) throw new Error("no SZ draft to compile");

  const resolved = resolveObservations(draft.observations);
  const rows =
    draft.profileIds.length > 0
      ? await db.select().from(profiles).where(inArray(profiles.id, draft.profileIds))
      : [];
  // Hybrid at M1 (user-ratified 2026-07-07): compile single-source; the
  // blend intent rides the contract's hybrid_recipe (notes) and the OSP's
  // deferred context so the Director honors it in prose until M4's
  // per-component assembly replaces this. The BASE is the world the player
  // chose to stand in (their world pick), else the first source loaded.
  const isHybrid = draft.profileIds.length > 1;
  let profileRow = rows.find((r) => r.id === draft.profileIds[0]);
  const worldPick = resolved.blendChoices.find((b) => b.component === "world");
  if (isHybrid && worldPick) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const match = rows.find(
      (r) =>
        r.id === worldPick.choice ||
        norm(worldPick.choice).includes(norm(r.title)) ||
        norm(r.title).includes(norm(worldPick.choice)),
    );
    if (match) profileRow = match;
  }
  const profileId = profileRow?.id;
  const gaps = gapVerdict(resolved, !!profileRow);
  if (gaps.length > 0) {
    return { gaps } as CompileResult; // blocking — handoff halted (§8)
  }
  const profile = Profile.parse(profileRow?.profile);
  if (isHybrid) {
    resolved.deferred.push(
      `hybrid premise compiled single-source (base: ${profileId}) — per-component assembly lands at M4; honor the recorded blend in prose meanwhile`,
    );
  }

  // CLAIM the compile before any side effect (C6 audit): ingestion and the
  // OSP call run OUTSIDE the final transaction (the clarify must feed the
  // OSP prompt), so the single-winner gate has to come FIRST or a lost-race
  // compile leaves orphaned ingestion writes behind. The claim is EXCLUSIVE
  // (C6 re-audit — inArray(draft,compiling) let two concurrent compiles both
  // claim, and the loser's catch-revert sabotaged the winner's flip): a live
  // 'compiling' row only re-claims once STALE, so a crash mid-compile stays
  // retryable while a concurrent compile loses here, before any side effect.
  const claimed = await db
    .update(campaigns)
    .set({ status: "compiling", updatedAt: new Date() })
    .where(
      and(
        eq(campaigns.id, campaignId),
        or(
          eq(campaigns.status, "draft"),
          and(
            eq(campaigns.status, "compiling"),
            lt(campaigns.updatedAt, new Date(Date.now() - STALE_COMPILE_CLAIM_MS)),
          ),
        ),
      ),
    )
    .returning({ id: campaigns.id });
  if (claimed.length === 0) {
    throw new Error(
      "compile lost the race — a compile is already in flight or the campaign is already active",
    );
  }

  try {
    // The C6 rebind (§5.4): SZ world/cast facts flow through the SAME
    // universal-ingestion subsystem as gameplay assertions — the resolver
    // links against canon and never duplicates; entities mint here and the
    // later brief admissions enrich-or-skip against them. Runs BEFORE the
    // OSP synthesis so a compile-time CLARIFY (unanswerable now — the
    // conversation is over) lands in the deferred context and becomes an
    // OSP uncertainty instead of vanishing. The deterministic critical_facts
    // sz_fact writes below are unchanged — guaranteed injection stays
    // guaranteed regardless of what ingestion does.
    const assertedText = [...resolved.worldFacts, ...resolved.castFacts]
      .map((o) => o.content)
      .join("\n");
    if (assertedText.trim()) {
      const ingest = opts.ingestor ?? ingestAssertion;
      try {
        const ingested = await ingest(db, campaignId, 0, assertedText, {
          profileIds: draft.profileIds,
          provenance: "sz_compiler",
        });
        if (ingested.clarify)
          resolved.deferred.push(`unresolved at the table: ${ingested.clarify}`);
        resolved.deferred.push(...ingested.flags);
      } catch (err) {
        // Ingestion enriches; it never gates the handoff. The critical-facts
        // path below still carries every assertion.
        console.warn(
          "[sz.compile] ingestion failed — assertions persist via critical facts only",
          err,
        );
      }
    }
    const blendNote = (component: string) => {
      const pick = resolved.blendChoices.find((b) => b.component === component);
      return pick
        ? `player chose: ${pick.choice} — M4 assembly pending`
        : "M1 single-source; blend unresolved for this component";
    };
    const hybridRecipe =
      isHybrid && profileId
        ? Object.fromEntries(
            ["world", "treatment", "framing", "voice", "canonicality"].map((c) => [
              c,
              { method: "single" as const, source_profile_ids: [profileId], notes: blendNote(c) },
            ]),
          )
        : undefined;

    // Canonical components from the profile; active = canonical + player moves.
    const canonicality: Canonicality = Canonicality.parse({
      timeline_mode: resolved.canonicality?.timeline_mode ?? "inspired",
      canon_cast_mode: resolved.canonicality?.canon_cast_mode ?? "full_cast",
      event_fidelity: resolved.canonicality?.event_fidelity ?? "influenceable",
      accepted_divergences: resolved.canonicality?.accepted_divergences ?? [],
      forbidden_contradictions: resolved.canonicality?.forbidden_contradictions ?? [],
    });
    const voice = {
      author_voice: profile.ip_mechanics.author_voice,
      voice_cards: profile.ip_mechanics.voice_cards,
      director_personality: profile.director_personality,
      cast_depth_posture: profile.cast_depth_posture ?? {
        main_cast: "broad-and-deep",
        supporting: "sharp silhouettes with one true note",
        recurring_bits: "role-filling",
      },
    };
    const { author_voice: _av, voice_cards: _vc, ...worldOnly } = profile.ip_mechanics;
    const canonical: PremiseComponents = {
      world: worldOnly,
      treatment: profile.canonical_dna,
      framing: profile.canonical_composition,
      voice,
      canonicality,
    };
    const active: PremiseComponents = structuredClone(canonical);
    for (const [axis, value] of Object.entries(resolved.calibration)) {
      active.treatment[axis as keyof DNAScales] = value as number;
    }
    // SV3: OP-composition moves are active-layer Framing overrides — the
    // canonical layer keeps the source's own framing, same as calibration.
    for (const { axis, value } of resolved.framingChoices) {
      (active.framing as Record<string, string>)[axis] = value;
    }

    const contract = PremiseContract.parse({
      campaign_id: campaignId,
      canonical,
      active,
      ...(hybridRecipe ? { hybrid_recipe: hybridRecipe } : {}),
      spark: resolved.spark,
      presentation_vocabulary: PresentationVocabulary.parse({
        grants: resolved.presentationGrants,
      }),
      finitude: resolved.finitude,
      intensity: {
        death_physics: resolved.deathPhysics,
        lethality_posture: resolved.lethalityPosture,
        hard_lines: resolved.hardLines,
        ...(resolved.controlKey ? { control_key: { circumstances: resolved.controlKey } } : {}),
      },
      suggestion_affordance: resolved.suggestionAffordance ?? "on_request_only",
      ...(resolved.pcPowerTier ? { pc_power_tier: resolved.pcPowerTier } : {}),
      anchors_used: draft.profileIds,
    });

    const synthesize = opts.ospSynthesizer ?? defaultOspSynthesizer;
    const ospDraft = await synthesize({
      campaignId,
      title: profile.title,
      spark: contract.spark,
      resolved,
      directorPersonality: profile.director_personality,
    });
    const opening = OpeningStatePackage.parse({
      ...ospDraft,
      constraints: ospDraft.constraints.map((c) => ({ ...c, ...SZ_ENVELOPE })),
      briefs: ospDraft.briefs.map((b) => ({ ...b, ...SZ_ENVELOPE })),
    });

    // --- Persistence: the handoff becomes state, atomically --------------------
    // One transaction; the compiling→active flip closes the claim taken above.
    // The claim (not this flip) is the single-winner gate — it fired before any
    // side effect, so a loser truly inserts nothing (C6 audit).
    await db.transaction(async (tx) => {
      const flipped = await tx
        .update(campaigns)
        .set({
          premiseContract: contract,
          openingPackage: opening,
          tierModels: resolved.tierSelection,
          status: "active",
          updatedAt: new Date(),
        })
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "compiling")))
        .returning({ id: campaigns.id });
      if (flipped.length === 0) {
        throw new Error("compile lost the race — this campaign is already active");
      }

      const critical = [
        `Finitude: ${contract.finitude} — only the player may change this.`,
        `Death physics: ${contract.intensity.death_physics}`,
        `Lethality posture: ${contract.intensity.lethality_posture}`,
        ...contract.intensity.hard_lines.map((l) => `HARD LINE (absolute): ${l}`),
        ...(contract.intensity.control_key
          ? [`Control key (player-cut): ${contract.intensity.control_key.circumstances}`]
          : []),
      ];
      await tx.insert(criticalFacts).values(
        critical.map((content) => ({
          campaignId,
          content,
          category: "contract",
          ...SZ_ROW,
          confidence: 1,
        })),
      );

      // Player-asserted facts persist DETERMINISTICALLY (player words are
      // world-building, never dropped) — the OSP call may also weave them into
      // briefs, but nothing about their survival depends on a model.
      const asserted = [...resolved.worldFacts, ...resolved.castFacts];
      if (asserted.length > 0) {
        await tx.insert(criticalFacts).values(
          asserted.map((o) => ({
            campaignId,
            content: o.content,
            category: "sz_fact",
            turnId: 0,
            provenance: "player_assertion",
            confidence: o.confidence,
          })),
        );
      }

      // The spark is the campaign's first pencil mark (§8).
      await tx.insert(pencilMarks).values({
        campaignId,
        kind: "craft_note",
        topic: "spark",
        direction: `Multiply this: ${contract.spark}`,
        evidence: "Session Zero, verbatim",
        ...SZ_ROW,
        confidence: 1,
      });

      // Catalog admission is an explicit act (§6.5) — briefs marked for it.
      // Conflict-safe: the ingestion resolver above may have minted the same
      // entity from a player assertion; the brief no-ops rather than erroring
      // the compile (the partial unique index is on campaign+type+name).
      const admitted = opening.briefs.filter((b) => b.admit_to_catalog);
      // §6.5 identity guard: overlapping briefs (a self-insert protagonist the
      // OSP named twice; near-duplicate names the exact-name index misses)
      // collapse BEFORE insert. DIFFERENT names for the same thing are M2
      // semantic-alias territory — dedupeAdmissions leaves them as-is.
      const deduped = dedupeAdmissions(admitted, resolved.pcName, {
        nameDeferred: resolved.pcNameDeferred,
      });
      if (deduped.length > 0) {
        const created = await tx
          .insert(entities)
          .values(
            deduped.map((e) => ({
              campaignId,
              name: e.name,
              entityType: e.entityType,
              block: e.block,
              // §6.5/M2 C4: the durable self-insert marker keeps the resolver's
              // protagonist alias attached to a REAL-named PC row.
              ...(e.isPlayerProtagonist ? { state: { is_player_protagonist: true } } : {}),
              ...SZ_ROW,
            })),
          )
          .onConflictDoNothing()
          .returning({ id: entities.id, block: entities.block });
        // Creation writes version 1 so a rewind can always restore the block
        // to a known state (C6 audit) — SZ admission is the THIRD minting
        // authority alongside g1 cast-admit and ingestion create, and an
        // unversioned mint leaves the block unrestorable once later enrich
        // versions tombstone away. `returning` yields only the rows actually
        // inserted, so a resolver-duplicate no-op mints no spurious version.
        if (created.length > 0) {
          await tx.insert(entityVersions).values(
            created.map((r) => ({
              entityId: r.id,
              version: 1,
              block: r.block,
              ...SZ_ROW,
            })),
          );
        }
      }

      // Player profile, thin (§6.9): taste observations accumulate — via the
      // atomic append (M2R R4 audit: three writers, one player row; a
      // read-modify-write replacement loses the losing writer's append).
      if (resolved.playerTaste.length > 0) {
        await appendPlayerTaste(tx, campaign.playerId, resolved.playerTaste);
      }
    });

    return { contract, opening, gaps: [] };
  } catch (err) {
    // Any failure after the claim reverts to 'draft' so retry works — but
    // NEVER un-claim a compile that actually completed (the transaction may
    // have landed before a late throw) or one another winner finished.
    try {
      await db
        .update(campaigns)
        .set({ status: "draft" })
        .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "compiling")));
    } catch {
      // best-effort — the 'compiling' claim is re-claimable anyway
    }
    throw err;
  }
}
