import { getDb } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import * as schema from "@/lib/db/schema";
import { SEED_MIN_TURNS_TO_PAYOFF, parseCandidates } from "@/lib/types/direction";
import { and, count, desc, eq, ilike } from "drizzle-orm";
import type { Suite, SuiteResult } from "../types";

/**
 * §6.8 the PROSPECTIVE flywheel — the M3 gate half of the acceptance pair.
 *
 * The M1 round-trip proves write→read: content planted through play comes back
 * when a probe asks for it. That is wiring. The prospective claim is P1's
 * actual one and it is different in kind: a fact planted through play and then
 * NEVER referenced again by the script must come back on the ENGINE's
 * initiative — surfaced by turn N+40 through the Director/seed/callback
 * machinery, with the trace naming the layer that supplied it. Not "does a
 * write surface later," but "does the engine USE what it stored to shape what
 * it plans."
 *
 * This suite makes NO model calls and drives NO turns. It reads the rows a
 * SOAK already recorded — contes, seeds, entities, player inputs — and
 * adjudicates them with pure code. Everything judged here was judged at play
 * time by the engine's own judges (the §7.6 batched adjudicator's verdicts, the
 * retrieval re-rank that admitted a memory to the conte); the suite reads those
 * verdicts, it does not re-open them.
 *
 *   FLYWHEEL_CAMPAIGN_ID=<uuid> pnpm evals flywheel-prospective
 *
 * With no campaign id it falls back to the newest campaign whose title looks
 * like a soak (the drift-soak resume pattern), and skips LOUDLY when there is
 * none — or when the one it finds is too short to carry the claim.
 */

/** §6.8's own number: the fact must surface by turn N+40. */
export const PROSPECTIVE_LAG_TURNS = 40;

/**
 * The suite's stated minimum, honestly. §10.3 asks for 50–100 turn runs; the
 * M2 gate ran a 24-turn script against that letter (a discrepancy recorded in
 * docs/retros/M2-drift-soak.md rather than papered over). A 40-turn lag cannot
 * be observed at all below ~50 turns, so below this the suite SKIPS and says
 * why — it never grades a short run against a claim the run cannot carry.
 */
export const MIN_SOAK_TURNS = 50;

/**
 * A callback reaching back this far is a real reach. It is deliberately NOT
 * the 40-turn figure: §6.8's N+40 belongs to the planted-fact claim, and
 * holding the Brief's callback channel to it would make the check vacuous on
 * a 50-turn run (nothing planted after turn 10 could ever qualify).
 */
export const CALLBACK_MIN_LAG_TURNS = 10;

/**
 * Fraction of a memory's distinctive words that may appear in the player's own
 * inputs between the plant and the surfacing before it stops counting as
 * prospective. "Planted and never referenced again" is the whole claim; a
 * memory the script kept saying out loud proves retrieval, not prospection.
 */
export const ECHO_OVERLAP = 0.5;

/**
 * The layer whose conte injections SUSTAIN THEMSELVES. `recordBoosts`
 * (src/lib/turn/retrieval.ts) re-boosts the heat of every `hot_baseline` memory
 * it just injected, so a memory admitted once keeps its own heat topped up and
 * rides every subsequent conte — its "lag" then grows one turn per turn for
 * free. A memory carried from turn 5 to turn 50 that way was never let go of,
 * so nothing REACHED for it; it is excluded from reach evidence and flagged
 * distinctly as an echo via heat.
 */
export const HEAT_DRIVEN_LAYER = "hot_baseline";

/** Conte memory contents are copied verbatim off the memory row; the key
 *  normalizes only case and whitespace, so a re-serialized copy still traces to
 *  the same material. */
function memoryKey(content: string): string {
  return content.toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Row shapes (what the suite reads; kept structural so a soak's stored conte
// never fails a strict parse and takes its own evidence down with it).
// ---------------------------------------------------------------------------

export interface TurnRow {
  turnNumber: number;
  playerInput: string;
  status: string;
  conte: unknown;
}

export interface SeedRow {
  description: string;
  expectedPayoff: string | null;
  status: string;
  plantedTurn: number;
  resolvedTurn: number | null;
  resolvedBy: string | null;
  mentionCount: number;
  candidates: unknown;
  provenance: string;
}

export interface EntityRow {
  name: string;
  turnId: number;
}

export interface FlywheelInput {
  campaignId: string;
  turns: TurnRow[];
  seeds: SeedRow[];
  entities: EntityRow[];
}

interface ConteRead {
  memories: { content: string; layer: string; turnId: number }[];
  callbacks: string[];
  spotlightHints: string[];
  mustReference: string[];
}

/** Tolerant conte read — a malformed field drops, it never throws away the turn. */
export function readConte(raw: unknown): ConteRead {
  const out: ConteRead = { memories: [], callbacks: [], spotlightHints: [], mustReference: [] };
  if (typeof raw !== "object" || raw === null) return out;
  const c = raw as Record<string, unknown>;
  if (Array.isArray(c.memories)) {
    for (const m of c.memories) {
      if (typeof m !== "object" || m === null) continue;
      const row = m as Record<string, unknown>;
      const content = typeof row.content === "string" ? row.content : null;
      const layer = typeof row.layer === "string" ? row.layer : "unknown";
      const turnId = typeof row.turn_id === "number" ? row.turn_id : null;
      if (content && turnId !== null) out.memories.push({ content, layer, turnId });
    }
  }
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  out.callbacks = strings(c.callbacks);
  out.spotlightHints = strings(c.spotlight_hints);
  const beat = c.pacer_beat;
  if (typeof beat === "object" && beat !== null) {
    out.mustReference = strings((beat as Record<string, unknown>).must_reference);
  }
  return out;
}

/** Length is the whole filter: short words are the connective tissue every
 *  sentence shares. Apostrophes split, so "the syndicate's pier" and "the
 *  syndicate" trace to the same material. */
export const DEFAULT_MIN_TOKEN = 6;

/** Entity NAMES trace at a lower floor — they are proper nouns matched whole,
 *  so their distinctiveness comes from being names, not from being long (a
 *  catalog of Jet, Ein and Faye is otherwise invisible to attribution). */
export const NAME_MIN_TOKEN = 3;

export function distinctiveTokens(text: string, minLength = DEFAULT_MIN_TOKEN): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= minLength) out.add(raw);
  }
  return out;
}

export function overlapFraction(material: Set<string>, corpus: Set<string>): number {
  if (material.size === 0) return 0;
  let hits = 0;
  for (const token of material) if (corpus.has(token)) hits += 1;
  return hits / material.size;
}

export interface Probe {
  name: string;
  required: boolean;
  ok: boolean;
  detail: string;
}

export interface FlywheelAnalysis {
  probes: Probe[];
  details: string[];
}

/**
 * The adjudication, pure. Four probes, all required: §6.8's claim needs a
 * surfacing AND the machinery that can produce one AND the trace naming the
 * layer. A run whose seed ledger never settles and whose Brief never calls
 * anything back has not demonstrated prospective memory just because one
 * retrieval happened to reach far.
 */
export function analyzeProspectiveFlywheel(input: FlywheelInput): FlywheelAnalysis {
  const details: string[] = [];
  const probes: Probe[] = [];
  const played = input.turns
    .filter((t) => t.status === "complete")
    .sort((a, b) => a.turnNumber - b.turnNumber);
  const inputTokensByTurn = new Map<number, Set<string>>();
  for (const t of played) inputTokensByTurn.set(t.turnNumber, distinctiveTokens(t.playerInput));

  /** Every distinctive word the SCRIPT said in (from, to] — the echo corpus. */
  const scriptCorpus = (from: number, to: number): Set<string> => {
    const corpus = new Set<string>();
    for (const [turn, tokens] of inputTokensByTurn) {
      if (turn <= from || turn > to) continue;
      for (const token of tokens) corpus.add(token);
    }
    return corpus;
  };

  // --- Probe 1: the reach (§6.8's letter) ----------------------------------
  interface Surfacing {
    layer: string;
    plantedTurn: number;
    surfacedTurn: number;
    lag: number;
    content: string;
  }
  // Every turn whose conte carried each memory. The suite already reads every
  // turn's conte; this is that same read, indexed by material — it is what
  // makes "and it was ABSENT in between" answerable at all.
  const conteTurnsByMemory = new Map<string, number[]>();
  for (const turn of played) {
    for (const memory of readConte(turn.conte).memories) {
      const key = memoryKey(memory.content);
      const seen = conteTurnsByMemory.get(key);
      if (seen) seen.push(turn.turnNumber);
      else conteTurnsByMemory.set(key, [turn.turnNumber]);
    }
  }

  const surfacings: Surfacing[] = [];
  let criticalSkipped = 0;
  let heatLayerSkipped = 0;
  let riddenSkipped = 0;
  let echoSkipped = 0;
  for (const turn of played) {
    const conte = readConte(turn.conte);
    for (const memory of conte.memories) {
      const lag = turn.turnNumber - memory.turnId;
      if (lag < PROSPECTIVE_LAG_TURNS) continue;
      // The Critical layer is GUARANTEED injection every turn (§6.3). It
      // proves nothing about prospective memory — an unconditional injection
      // would "surface" at any lag whatsoever — so it is excluded by design.
      if (memory.layer === "critical") {
        criticalSkipped += 1;
        continue;
      }
      // The self-boosting layer, excluded for the same reason as Critical: its
      // injections buy their own next injection (HEAT_DRIVEN_LAYER).
      if (memory.layer === HEAT_DRIVEN_LAYER) {
        heatLayerSkipped += 1;
        continue;
      }
      // ABSENCE across the lag span is half the claim — "planted and then
      // never referenced again" is about the ENGINE's contes, not only the
      // player's mouth. A memory that sat in the conte the whole way was
      // copied forward, never reached for; heat can do that on any layer, not
      // just the one named above, so the evidence is the appearances.
      const rode = (conteTurnsByMemory.get(memoryKey(memory.content)) ?? []).some(
        (t) => t > memory.turnId && t < turn.turnNumber,
      );
      if (rode) {
        riddenSkipped += 1;
        continue;
      }
      const material = distinctiveTokens(memory.content);
      if (overlapFraction(material, scriptCorpus(memory.turnId, turn.turnNumber)) >= ECHO_OVERLAP) {
        echoSkipped += 1;
        continue;
      }
      surfacings.push({
        layer: memory.layer,
        plantedTurn: memory.turnId,
        surfacedTurn: turn.turnNumber,
        lag,
        content: memory.content.slice(0, 120),
      });
    }
  }
  surfacings.sort((a, b) => b.lag - a.lag);
  const deepest = surfacings[0];
  const heatFlagged = heatLayerSkipped + riddenSkipped;
  const heatNote = `${heatFlagged} flagged 'echo via heat' (${heatLayerSkipped} on the self-boosting '${HEAT_DRIVEN_LAYER}' layer, ${riddenSkipped} present in the contes across the lag span) — never counted as reach`;
  probes.push({
    name: "reach",
    required: true,
    ok: surfacings.length > 0,
    detail: deepest
      ? `${surfacings.length} unechoed surfacing(s) at lag ≥ ${PROSPECTIVE_LAG_TURNS}; deepest: layer '${deepest.layer}' planted turn ${deepest.plantedTurn} → surfaced turn ${deepest.surfacedTurn} (lag ${deepest.lag}) — "${deepest.content}"; ${heatNote}`
      : `no non-critical memory surfaced at lag ≥ ${PROSPECTIVE_LAG_TURNS} (${criticalSkipped} critical-layer injections excluded by design, ${heatNote}, ${echoSkipped} echoed by the script)`,
  });

  // --- Probe 2: layer attribution (§6.8's "which layer supplied it") -------
  const byLayer = new Map<string, number>();
  for (const s of surfacings) byLayer.set(s.layer, (byLayer.get(s.layer) ?? 0) + 1);
  probes.push({
    name: "layer-attribution",
    required: true,
    ok: byLayer.size > 0 && !byLayer.has("unknown"),
    detail:
      byLayer.size === 0
        ? "nothing to attribute — no prospective surfacing to trace"
        : [...byLayer.entries()].map(([layer, n]) => `${layer}×${n}`).join(", "),
  });

  // --- Probe 3: the seed ledger turns (§7.6 — direction using memory) ------
  const seeds = input.seeds;
  const settled = seeds.filter((s) => s.resolvedTurn !== null);
  const judged = settled.filter((s) => (s.resolvedBy ?? "").startsWith("adjudicator"));
  const aged = settled.filter(
    (s) => (s.resolvedTurn ?? 0) - s.plantedTurn >= SEED_MIN_TURNS_TO_PAYOFF,
  );
  const organic = seeds.filter((s) =>
    parseCandidates(s.candidates).some((c) => c.t > s.plantedTurn),
  );
  const maxSeedLag = settled.reduce(
    (max, s) => Math.max(max, (s.resolvedTurn ?? 0) - s.plantedTurn),
    0,
  );
  probes.push({
    name: "seed-ledger-turns",
    required: true,
    // `aged OR judged`, not AND, and that is deliberate. A seed the §7.6
    // adjudicator settled inside SEED_MIN_TURNS_TO_PAYOFF is a FAST payoff —
    // the player walked into the thing early — and a fast payoff is a story
    // choice, not an integrity failure. The lag floor is what the Director
    // PLANS toward; the adjudicator's verdict is what actually happened at the
    // table, and player authority (§0) says the table wins. Short-lag judged
    // payoffs therefore count. Nothing is hidden by this: the detail below
    // always reports how many aged, how many were judged, and the deepest lag,
    // so a ledger that only ever pays off instantly is visible on its face.
    ok: seeds.length > 0 && (aged.length > 0 || judged.length > 0),
    detail:
      seeds.length === 0
        ? "the seed ledger is EMPTY — the Director never planted, so nothing could pay off"
        : `${seeds.length} seed(s): ${settled.length} settled (${judged.length} judged by the §7.6 adjudicator), ${aged.length} paid off at ≥ ${SEED_MIN_TURNS_TO_PAYOFF} turns' lag (deepest ${maxSeedLag}), ${organic.length} carrying organic candidates found after the plant`,
  });

  // --- Probe 4: the callback channel (the Brief reaching back) -------------
  interface Callback {
    text: string;
    source: string;
    plantedTurn: number;
    surfacedTurn: number;
    lag: number;
  }
  const plants: { name: string; turn: number; tokens: Set<string> }[] = [
    ...input.seeds.map((s) => ({
      name: `seed@${s.plantedTurn}`,
      turn: s.plantedTurn,
      tokens: distinctiveTokens(s.description),
    })),
    ...input.entities.map((e) => ({
      name: `entity '${e.name}'`,
      turn: e.turnId,
      tokens: distinctiveTokens(e.name, NAME_MIN_TOKEN),
    })),
  ].filter((p) => p.tokens.size > 0);

  const callbacks: Callback[] = [];
  for (const turn of played) {
    const conte = readConte(turn.conte);
    const lines = [...conte.callbacks, ...conte.spotlightHints, ...conte.mustReference];
    for (const line of lines) {
      const lineTokens = distinctiveTokens(line);
      for (const plant of plants) {
        if (plant.turn >= turn.turnNumber) continue;
        // The plant's own words appearing in the Brief line: attribution by
        // shared distinctive vocabulary, the same trick the organic sweep
        // makes with embeddings — deterministic here because a suite that
        // needs a model call is not a suite the CI gate can run.
        if (overlapFraction(plant.tokens, lineTokens) < ECHO_OVERLAP) continue;
        callbacks.push({
          text: line.slice(0, 100),
          source: plant.name,
          plantedTurn: plant.turn,
          surfacedTurn: turn.turnNumber,
          lag: turn.turnNumber - plant.turn,
        });
        break;
      }
    }
  }
  callbacks.sort((a, b) => b.lag - a.lag);
  const reaching = callbacks.filter((c) => c.lag >= CALLBACK_MIN_LAG_TURNS);
  const deepestCallback = reaching[0];
  probes.push({
    name: "callback-channel",
    required: true,
    ok: reaching.length > 0,
    detail: deepestCallback
      ? `${reaching.length} Brief line(s) traced to material planted ≥ ${CALLBACK_MIN_LAG_TURNS} turns earlier; deepest: ${deepestCallback.source} → turn ${deepestCallback.surfacedTurn} (lag ${deepestCallback.lag}) — "${deepestCallback.text}"`
      : `no conte callback / spotlight hint / must_reference traced to material planted ≥ ${CALLBACK_MIN_LAG_TURNS} turns earlier (${callbacks.length} attributed at any lag)`,
  });

  details.push(`campaign ${input.campaignId}: ${played.length} completed turns read`);
  details.push(
    `prospective surfacings at lag ≥ ${PROSPECTIVE_LAG_TURNS}: ${surfacings.length} (critical-layer excluded: ${criticalSkipped}; echo via heat: ${heatFlagged} = ${heatLayerSkipped} '${HEAT_DRIVEN_LAYER}' + ${riddenSkipped} ridden across the lag; script-echoed: ${echoSkipped})`,
  );
  for (const probe of probes) {
    details.push(`${probe.ok ? "ok" : "MISS"} ${probe.name}: ${probe.detail}`);
  }
  return { probes, details };
}

// ---------------------------------------------------------------------------
// The suite: campaign selection, the loud skips, then the pure adjudication.
// ---------------------------------------------------------------------------

const HOW_TO_SOAK = `run one first: \`pnpm soak -- --turns=${MIN_SOAK_TURNS}\` or deeper (the M3 gate runs 100), then re-run with FLYWHEEL_CAMPAIGN_ID=<campaign uuid>`;

async function loadInput(campaignId: string): Promise<FlywheelInput> {
  const db = getDb();
  const turns = await db
    .select({
      turnNumber: schema.turns.turnNumber,
      playerInput: schema.turns.playerInput,
      status: schema.turns.status,
      conte: schema.turns.conte,
    })
    .from(schema.turns)
    .where(eq(schema.turns.campaignId, campaignId));

  const seeds = await db
    .select({
      description: schema.seeds.description,
      expectedPayoff: schema.seeds.expectedPayoff,
      status: schema.seeds.status,
      plantedTurn: schema.seeds.plantedTurn,
      resolvedTurn: schema.seeds.resolvedTurn,
      resolvedBy: schema.seeds.resolvedBy,
      mentionCount: schema.seeds.mentionCount,
      candidates: schema.seeds.candidates,
      provenance: schema.seeds.provenance,
    })
    .from(schema.seeds)
    .where(and(eq(schema.seeds.campaignId, campaignId), notTombstoned(schema.seeds)));

  const entities = await db
    .select({ name: schema.entities.name, turnId: schema.entities.turnId })
    .from(schema.entities)
    .where(and(eq(schema.entities.campaignId, campaignId), notTombstoned(schema.entities)));

  return { campaignId, turns, seeds, entities };
}

type CandidateCampaign = { id: string; title: string; played: number };

/** Env id first; else the deepest soak-looking campaign (the drift-soak pattern). */
async function resolveCampaignId(): Promise<{ id: string; how: string } | null> {
  const fromEnv = process.env.FLYWHEEL_CAMPAIGN_ID?.trim();
  if (fromEnv) return { id: fromEnv, how: "FLYWHEEL_CAMPAIGN_ID" };
  // Auto-discovery is a convenience for the integrator at his own machine. The
  // dev database also holds the PLAYER's campaigns, and a CI job must never
  // grade a campaign nobody pointed it at — under --ci the id is required.
  if (process.argv.includes("--ci")) return null;
  const rows = await getDb()
    .select({
      id: schema.campaigns.id,
      title: schema.campaigns.title,
      played: count(schema.turns.id),
    })
    .from(schema.campaigns)
    .leftJoin(
      schema.turns,
      and(eq(schema.turns.campaignId, schema.campaigns.id), eq(schema.turns.status, "complete")),
    )
    .where(ilike(schema.campaigns.title, "%soak%"))
    .groupBy(schema.campaigns.id, schema.campaigns.title, schema.campaigns.createdAt)
    .orderBy(desc(schema.campaigns.createdAt));
  if (rows.length === 0) return null;
  // Newest QUALIFYING run first: soak campaigns accumulate, and the newest row
  // is often an aborted husk with zero turns — picking it would report "0
  // completed turns" while a real 100-turn run sat one row down.
  const qualifying = rows.find((r) => r.played >= MIN_SOAK_TURNS);
  const chosen =
    qualifying ??
    rows.reduce((best, r) => (r.played > best.played ? r : best), rows[0] as CandidateCampaign);
  return {
    id: chosen.id,
    how: `${qualifying ? "newest qualifying" : "deepest"} soak-titled campaign ("${chosen.title}", ${chosen.played} completed turns)`,
  };
}

export const flywheelProspective: Suite = {
  name: "flywheel-prospective",
  gate: "M3 (§6.8 prospective / §10.3)",
  // No model call anywhere: the soak already paid for the judgment this reads.
  requiresLlm: false,
  async run(): Promise<SuiteResult> {
    const skip = (reason: string): SuiteResult => ({
      name: "flywheel-prospective",
      gate: "M3 (§6.8 prospective / §10.3)",
      status: "skipped",
      details: [reason],
      failures: [],
    });

    if (!process.env.DATABASE_URL) {
      return skip(
        `NEEDS a soaked campaign of ≥ ${MIN_SOAK_TURNS} turns and DATABASE_URL is unset — nothing was measured; ${HOW_TO_SOAK}`,
      );
    }

    let input: FlywheelInput;
    let how: string;
    try {
      const target = await resolveCampaignId();
      if (!target) {
        return skip(
          `NEEDS a soaked campaign of ≥ ${MIN_SOAK_TURNS} turns; none found (no FLYWHEEL_CAMPAIGN_ID, no soak-titled campaign) — ${HOW_TO_SOAK}`,
        );
      }
      how = target.how;
      input = await loadInput(target.id);
    } catch (err) {
      // A skip here says "nothing was measured", which is the truth; it must
      // never read as a pass.
      return skip(
        `could not read the soaked campaign — nothing measured: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const played = input.turns.filter((t) => t.status === "complete").length;
    if (played < MIN_SOAK_TURNS) {
      return skip(
        `campaign ${input.campaignId} (${how}) has ${played} completed turns; this suite needs ≥ ${MIN_SOAK_TURNS} — §6.8's claim is a fact surfacing at lag ${PROSPECTIVE_LAG_TURNS}, which a shorter run cannot carry at all. §10.3 asks 50–100 turn runs; the M2 gate ran 24 against that letter (docs/retros/M2-drift-soak.md). ${HOW_TO_SOAK}`,
      );
    }

    const { probes, details } = analyzeProspectiveFlywheel(input);
    const failures = probes.filter((p) => p.required && !p.ok).map((p) => `${p.name}: ${p.detail}`);
    return {
      name: this.name,
      gate: this.gate,
      status: failures.length === 0 ? "pass" : "fail",
      details: [`campaign source: ${how}`, ...details],
      failures,
    };
  },
};
