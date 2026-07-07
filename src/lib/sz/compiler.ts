import type { Db } from "@/lib/db";
import {
  campaigns,
  criticalFacts,
  entities,
  pencilMarks,
  players,
  profiles,
} from "@/lib/db/schema";
import { callJudgment } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import { DNAScales } from "@/lib/types/dna";
import { OpeningStatePackage } from "@/lib/types/opening";
import {
  Canonicality,
  type PremiseComponents,
  PremiseContract,
  PresentationVocabulary,
  SuggestionAffordance,
} from "@/lib/types/premise";
import { Profile } from "@/lib/types/profile";
import { and, eq } from "drizzle-orm";
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

// --- Resolution: latest-wins per kind (per-axis for calibration) -----------

export interface ResolvedObservations {
  spark?: string;
  finitude?: "finite" | "indefinite" | "undecided";
  deathPhysics?: string;
  lethalityPosture?: string;
  hardLines: string[];
  controlKey?: string;
  calibration: Partial<Record<keyof DNAScales, number>>;
  canonicality?: Partial<Canonicality>;
  presentationGrants: string[];
  suggestionAffordance?: z.infer<typeof SuggestionAffordance>;
  tierSelection?: TierSelection;
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
  const anchored = /^\s*["'“]?(indefinite|undecided|finite)\b/i.exec(content);
  if (anchored) return anchored[1]?.toLowerCase() as Finitude;
  const hits = new Set<Finitude>();
  if (/\bindefinite(ly)?\b/i.test(content)) hits.add("indefinite");
  if (/\bundecided\b/i.test(content)) hits.add("undecided");
  if (/\bfinite\b/i.test(content)) hits.add("finite");
  return hits.size === 1 ? [...hits][0] : undefined;
}

export function resolveObservations(observations: Observation[]): ResolvedObservations {
  const resolved: ResolvedObservations = {
    hardLines: [],
    calibration: {},
    presentationGrants: [],
    worldFacts: [],
    castFacts: [],
    playerTaste: [],
    deferred: [],
  };
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
      case "death_physics":
        resolved.deathPhysics = obs.content;
        break;
      case "lethality_posture":
        resolved.lethalityPosture = obs.content;
        break;
      case "hard_line":
        resolved.hardLines.push(obs.content);
        break;
      case "control_key":
        resolved.controlKey = obs.content;
        break;
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
      case "presentation":
        resolved.presentationGrants.push(obs.content);
        break;
      case "suggestion_affordance": {
        const value = SuggestionAffordance.options.find((o) => obs.content.includes(o));
        resolved.suggestionAffordance =
          value ?? (obs.content.toLowerCase().includes("never") ? "never" : "on_request_only");
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
  return resolved;
}

// --- Gap verdict (deterministic, blocking) ----------------------------------

export function gapVerdict(resolved: ResolvedObservations, hasProfile: boolean): string[] {
  const gaps: string[] = [];
  if (!hasProfile) gaps.push("no researched profile — the World never loaded");
  if (!resolved.spark) gaps.push("the spark was never gathered (§8's one mandatory question)");
  if (!resolved.finitude) gaps.push("finitude undetermined — the Series contract is sacrosanct");
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
      "forbidden_opening_moves protect the cold open (no premature reveals,",
      "no spending the spark in scene one). Briefs are seeds for the entity",
      "layer; admit_to_catalog=true only for entities certain to persist.",
      "Orphan facts: anything true that fits nowhere — keep, never drop.",
    ].join(" "),
    prompt: [
      `Title: ${title}`,
      `Director personality: ${directorPersonality}`,
      `THE SPARK (verbatim): ${spark}`,
      `Finitude: ${resolved.finitude}`,
      `Death physics: ${resolved.deathPhysics}`,
      `Lethality: ${resolved.lethalityPosture}`,
      `Hard lines: ${resolved.hardLines.join("; ") || "(none)"}`,
      `Control key: ${resolved.controlKey ?? "(not on the table)"}`,
      `World facts: ${resolved.worldFacts.map((o) => o.content).join("; ") || "(none)"}`,
      `Cast facts: ${resolved.castFacts.map((o) => o.content).join("; ") || "(none)"}`,
      `Deferred (Director's territory — likely uncertainties): ${resolved.deferred.join("; ") || "(none)"}`,
    ].join("\n"),
    effort: "high",
    maxTokens: 8_000,
  });
};

// --- Compile -----------------------------------------------------------------

export interface CompileResult {
  contract: PremiseContract;
  opening: OpeningStatePackage;
  gaps: string[];
}

export async function compileSessionZero(
  db: Db,
  campaignId: string,
  opts: { ospSynthesizer?: OspSynthesizer } = {},
): Promise<CompileResult> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) throw new Error("campaign not found");
  const draft = campaign.szTranscript as ConductorDraft | null;
  if (!draft) throw new Error("no SZ draft to compile");

  const resolved = resolveObservations(draft.observations);
  const profileId = draft.profileIds[0];
  const [profileRow] = profileId
    ? await db.select().from(profiles).where(eq(profiles.id, profileId))
    : [];
  const gaps = gapVerdict(resolved, !!profileRow);
  if (gaps.length > 0) {
    return { gaps } as CompileResult; // blocking — handoff halted (§8)
  }
  const profile = Profile.parse(profileRow?.profile);

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

  const contract = PremiseContract.parse({
    campaign_id: campaignId,
    canonical,
    active,
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
  // One transaction, and the draft→active flip is its concurrency gate: two
  // racing compiles both pass the route's status check (the OSP call is slow),
  // but only one wins this conditional update — the loser inserts nothing.
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
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "draft")))
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
    const admitted = opening.briefs.filter((b) => b.admit_to_catalog);
    if (admitted.length > 0) {
      await tx.insert(entities).values(
        admitted.map((b) => ({
          campaignId,
          name: b.name,
          entityType:
            b.kind === "cast"
              ? "npc"
              : b.kind === "faction"
                ? "faction"
                : b.kind === "world"
                  ? "location"
                  : "thread",
          block: b.brief,
          ...SZ_ROW,
        })),
      );
    }

    // Player profile, thin (§6.9): taste observations accumulate.
    if (resolved.playerTaste.length > 0) {
      const [player] = await tx.select().from(players).where(eq(players.id, campaign.playerId));
      const existing = (player?.profile as { taste?: string[] } | null) ?? {};
      await tx
        .update(players)
        .set({
          profile: { ...existing, taste: [...(existing.taste ?? []), ...resolved.playerTaste] },
        })
        .where(eq(players.id, campaign.playerId));
    }
  });

  return { contract, opening, gaps: [] };
}
