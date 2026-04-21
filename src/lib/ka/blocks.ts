import type { CompositionMode } from "@/lib/agents/scale-selector-agent";
import { getPrompt } from "@/lib/prompts";
import type { Composition } from "@/lib/types/composition";
import type { DNAScales, PartialDNAScales } from "@/lib/types/dna";
import { dnaDelta } from "@/lib/types/dna";
import type { Profile } from "@/lib/types/profile";
import type { IntentOutput, OutcomeOutput } from "@/lib/types/turn";

/**
 * Render the four KA system blocks from campaign state.
 *
 * Block 1 (ambient): Profile DNA + composition + rule library + voice —
 *   cached across the session. Only invalidates when the campaign's
 *   canonical Profile changes (rare) or when Director updates the
 *   voice_patterns journal (session boundaries).
 * Block 2 (compaction): append-only micro-summaries of evicted working
 *   memory. Empty until Compactor fires. Cached.
 * Block 3 (working): last N player/DM exchanges. Cached but slides.
 * Block 4 (dynamic): per-turn context — intent, outcome, sakuga,
 *   style drift, vocab freshness, arc state, overrides. Uncached.
 *
 * Substitution uses `{{variable}}` syntax distinct from the prompt
 * registry's `{{include:...}}` (which is resolved at load time, before
 * this function runs). Unresolved tokens are left as `[UNSET: name]`
 * so drift is visible in traces and dump output rather than silently
 * leaking `{{name}}` into the model's context.
 */

export interface WorkingMemoryTurn {
  turn_number: number;
  player_message: string;
  narrative_text: string;
}

export interface CompactionEntry {
  /** Pre-rendered micro-summary prose, written by Compactor. */
  text: string;
  /** Range of turn numbers this summary covers, for trace alignment. */
  turns_covered: [number, number];
}

export interface Block4Context {
  intent: IntentOutput;
  outcome?: OutcomeOutput;
  /**
   * Effective composition mode for this turn — standard | blended |
   * op_dominant | not_applicable. Deterministically computed in the turn
   * workflow from attacker/defender tier gap. Rendered in Block 4 so KA
   * sees the mode shift (OP-dominant reframes stakes onto meaning, not
   * survival).
   */
  active_composition_mode?: CompositionMode;
  /**
   * Beat-craft guidance text for the current arc phase (Phase 7 polish,
   * MINOR #18). Rendered alongside arc_phase so KA sees how to narrate
   * the phase (setup orients, complication destabilizes, etc.), not
   * just the name of the phase.
   */
  arc_phase_craft?: string;
  /**
   * Tiered semantic-memory retrieval budget (§9). 0/3/6/9 by epicness.
   * Rendered as an advisory directive in Block 4 — KA decides how
   * aggressively to query `search_memory` given the budget.
   */
  retrieval_budget?: 0 | 3 | 6 | 9;
  sakuga_injection?: string;
  style_drift_directive?: string;
  vocabulary_freshness_advisory?: string;
  director_notes?: string;
  /** Player's hard constraints, formatted as a list for the model. */
  player_overrides: string[];
  /** Arc plan slice KA needs this turn. */
  arc_state?: {
    current_arc?: string | null;
    arc_phase?: string | null;
    tension_level?: number | null;
  };
  active_foreshadowing?: Array<{ id: string; name: string; status: string }>;
  scene?: {
    location?: string | null;
    situation?: string | null;
    time_context?: string | null;
    present_npcs?: string[];
  };
}

/**
 * Flat campaign-state view the renderer needs. Lifted out of the full
 * Zod `Campaign` because at M1 the Session-Zero-produced `active_ip`
 * and `arc_override` aren't populated yet; the renderer takes just
 * what it reads, not the full SZ artifact.
 */
export interface CampaignView {
  active_dna?: DNAScales;
  active_composition?: Composition;
  arc_override?: {
    dna?: PartialDNAScales;
  };
}

export interface RenderBlocksInput {
  profile: Profile;
  campaign: CampaignView;
  workingMemory: WorkingMemoryTurn[];
  compaction: CompactionEntry[];
  block4: Block4Context & {
    /** Raw player message for this turn. */
    player_message: string;
  };
  voicePatternsJournal?: string;
  /** Session-stable rule-library guidance (currently empty at M1). */
  sessionRuleLibrary?: string;
  /**
   * Session-start context-blocks bundle for Block 2. Per-entity living
   * summaries (arc, threads, quests, NPCs, factions, locations) — the
   * distilled campaign state KA reads before writing the scene. Block 2
   * is semi-static, invalidates when any block updates.
   */
  sessionContextBlocks?: string;
  /**
   * Effective composition mode for this turn. Threaded into Block 1's
   * active_tonal_state display when non-standard so KA sees the mode
   * shift alongside DNA + composition. Block 4 shows the same value as
   * its own template var for per-turn surfacing.
   */
  activeCompositionMode?: CompositionMode;
}

export interface RenderedBlocks {
  block1: string;
  block2: string;
  block3: string;
  block4: string;
}

const VARIABLE_RE = /\{\{([a-zA-Z0-9_]+)\}\}/g;

/**
 * Substitute {{var}} tokens in a template. Unresolved tokens render as
 * `[UNSET: name]` so drift is visible in trace output; in dev mode we
 * also console.warn so the regression surfaces before it reaches a turn.
 * Phase 7 polish (v3-audit closure MINOR #24).
 */
function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(VARIABLE_RE, (_match, name: string) => {
    const v = vars[name];
    if (v === undefined) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[blocks] unfilled template var: {{${name}}}`);
      }
      return `[UNSET: ${name}]`;
    }
    return v;
  });
}

function formatDna(dna: DNAScales | PartialDNAScales): string {
  const keys = Object.keys(dna).sort();
  if (keys.length === 0) return "(none set)";
  return keys.map((k) => `  ${k}: ${(dna as Record<string, number>)[k]}`).join("\n");
}

function formatComposition(comp: Record<string, unknown>): string {
  const keys = Object.keys(comp).sort();
  if (keys.length === 0) return "(none set)";
  return keys.map((k) => `  ${k}: ${String(comp[k])}`).join("\n");
}

function formatDnaDelta(canonical: DNAScales, active: DNAScales | undefined): string {
  if (!active) return "(none — campaign uses canonical DNA)";
  const delta = dnaDelta(canonical, active);
  const nonzero = Object.entries(delta).filter(([, v]) => Math.abs(v) > 0);
  if (nonzero.length === 0) return "(zero drift — matches canonical)";
  return nonzero
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([k, v]) => `  ${k}: ${v > 0 ? "+" : ""}${v}`)
    .join("\n");
}

function formatTropes(tropes: Record<string, boolean>): string {
  const active = Object.entries(tropes)
    .filter(([, on]) => on)
    .map(([k]) => k);
  if (active.length === 0) return "(none active)";
  return active.map((t) => `  - ${t}`).join("\n");
}

function formatVoiceCards(cards: unknown): string {
  if (!Array.isArray(cards) || cards.length === 0) return "(none defined)";
  return cards
    .map((c) => {
      const card = c as Record<string, unknown>;
      return `  • ${String(card.name)}: ${String(card.speech_patterns ?? "")}`;
    })
    .join("\n");
}

function formatAuthorVoice(voice: unknown): string {
  if (!voice || typeof voice !== "object") return "(none defined)";
  const v = voice as Record<string, unknown>;
  const lines: string[] = [];
  if (Array.isArray(v.sentence_patterns) && v.sentence_patterns.length > 0) {
    lines.push(`  sentence_patterns: ${(v.sentence_patterns as string[]).join("; ")}`);
  }
  if (Array.isArray(v.structural_motifs) && v.structural_motifs.length > 0) {
    lines.push(`  structural_motifs: ${(v.structural_motifs as string[]).join("; ")}`);
  }
  if (Array.isArray(v.dialogue_quirks) && v.dialogue_quirks.length > 0) {
    lines.push(`  dialogue_quirks: ${(v.dialogue_quirks as string[]).join("; ")}`);
  }
  if (typeof v.example_voice === "string") {
    lines.push(`  example_voice: ${v.example_voice}`);
  }
  return lines.length ? lines.join("\n") : "(none defined)";
}

/**
 * Format the power system block with limitations foregrounded. v3
 * explicitly formatted `**LIMITATIONS (You MUST Respect These):**` with
 * directive weight; dumping the raw JSON (as v4 did pre-Phase-7) loses
 * that emphasis. Phase 7 polish (MINOR #16).
 */
function formatPowerSystem(ps: Profile["ip_mechanics"]["power_system"]): string {
  if (!ps) return "(no canonical power system — narrate without system constraints)";
  const lines: string[] = [`**${ps.name}** — ${ps.mechanics}`];
  if (ps.tiers.length > 0) {
    lines.push(`Tiers: ${ps.tiers.join(", ")}`);
  }
  if (ps.limitations?.trim()) {
    lines.push("", "**LIMITATIONS (you MUST respect these):**", ps.limitations.trim());
  }
  return lines.join("\n");
}

function formatPresentNpcs(npcs: string[] | undefined): string {
  return npcs && npcs.length > 0 ? npcs.join(", ") : "(none in scene)";
}

function formatForeshadowing(seeds: Block4Context["active_foreshadowing"]): string {
  if (!seeds || seeds.length === 0) return "(no active seeds)";
  return seeds.map((s) => `  - ${s.name} [${s.status}] (${s.id})`).join("\n");
}

function formatCompaction(entries: CompactionEntry[]): string {
  if (entries.length === 0) {
    return "(empty — working memory hasn't overflowed in this session)";
  }
  return entries
    .map((e) => `Turns ${e.turns_covered[0]}–${e.turns_covered[1]}: ${e.text}`)
    .join("\n\n");
}

function formatWorkingMemory(turns: WorkingMemoryTurn[]): string {
  if (turns.length === 0) return "(this is the first turn of the campaign)";
  return turns
    .map((t) => `### Turn ${t.turn_number}\nPLAYER: ${t.player_message}\nDM: ${t.narrative_text}`)
    .join("\n\n");
}

function formatOverrides(overrides: string[]): string {
  if (overrides.length === 0) return "(none set)";
  return overrides.map((o) => `  - ${o}`).join("\n");
}

function formatSpecialConditions(conds: string[]): string {
  return conds.length ? conds.join(", ") : "(none)";
}

function formatOutcome(outcome: OutcomeOutput | undefined): string {
  if (!outcome) {
    return "(not mechanically judged — narrate consistently with the scene, consult OutcomeJudge yourself if a mechanical verdict would clarify consequences)";
  }
  const lines = [
    `  success_level: ${outcome.success_level}`,
    `  difficulty_class: ${outcome.difficulty_class}`,
    `  narrative_weight: ${outcome.narrative_weight}`,
  ];
  if (outcome.consequence) lines.push(`  consequence: ${outcome.consequence}`);
  if (outcome.cost) lines.push(`  cost: ${outcome.cost}`);
  if (outcome.rationale) lines.push(`  rationale: ${outcome.rationale}`);
  return lines.join("\n");
}

function formatRetrievalBudget(budget: 0 | 3 | 6 | 9 | undefined): string {
  if (budget === undefined || budget === 0) {
    return "0 — this beat does not warrant reaching into semantic memory; rely on Blocks 2-3 and scene context";
  }
  return `${budget} — you may consult up to ${budget} semantic-memory hits via \`search_memory\` this turn`;
}

/**
 * Render all four KA blocks. Returns strings ready to pass into Agent
 * SDK's `systemPrompt: string[]`. Caller assembles the final array
 * with `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` between blocks 3 and 4.
 */
export function renderKaBlocks(input: RenderBlocksInput): RenderedBlocks {
  const { profile, campaign, workingMemory, compaction, block4 } = input;

  // --- Block 1 (ambient) ---
  const activeDna = campaign.active_dna ?? profile.canonical_dna;
  const activeComposition = campaign.active_composition ?? profile.canonical_composition;

  const activeModeLine = input.activeCompositionMode
    ? `effective_composition_mode: ${input.activeCompositionMode}`
    : null;
  const block1Vars: Record<string, string> = {
    profile_title: profile.title,
    profile_media_type: profile.media_type,
    profile_canonical_dna: formatDna(profile.canonical_dna),
    profile_canonical_composition: formatComposition(
      profile.canonical_composition as unknown as Record<string, unknown>,
    ),
    active_tonal_state: [
      "dna:",
      formatDna(activeDna),
      "composition:",
      formatComposition(activeComposition as unknown as Record<string, unknown>),
      ...(activeModeLine ? [activeModeLine] : []),
    ].join("\n"),
    dna_delta: formatDnaDelta(profile.canonical_dna, activeDna),
    profile_power_system: formatPowerSystem(profile.ip_mechanics.power_system),
    profile_power_distribution: JSON.stringify(profile.ip_mechanics.power_distribution, null, 2),
    profile_stat_mapping: profile.ip_mechanics.stat_mapping
      ? JSON.stringify(profile.ip_mechanics.stat_mapping, null, 2)
      : "(no canonical stat mapping — narrate without sheet mechanics)",
    active_tropes: formatTropes(profile.ip_mechanics.storytelling_tropes),
    profile_voice_cards: formatVoiceCards(profile.ip_mechanics.voice_cards),
    profile_author_voice: formatAuthorVoice(profile.ip_mechanics.author_voice),
    profile_visual_style: JSON.stringify(profile.ip_mechanics.visual_style, null, 2),
    profile_combat_style: profile.ip_mechanics.combat_style,
    director_personality: profile.director_personality,
    session_rule_library_guidance:
      input.sessionRuleLibrary ?? "(no rule-library guidance loaded this session)",
    voice_patterns_journal:
      input.voicePatternsJournal ??
      "(empty — Director has not yet built a voice journal for this campaign)",
  };

  const block1Template = getPrompt("ka/block_1_ambient").content;
  const block1 = substitute(block1Template, block1Vars);

  // --- Block 2 (compaction + session context-block briefing) ---
  const block2Template = getPrompt("ka/block_2_compaction").content;
  const block2 = substitute(block2Template, {
    compaction_entries: formatCompaction(compaction),
    session_context_blocks:
      input.sessionContextBlocks ??
      "(no context blocks yet — Chronicler will build them as NPCs, arcs, and locations solidify through play)",
  });

  // --- Block 3 (working memory) ---
  const block3Template = getPrompt("ka/block_3_working").content;
  const block3 = substitute(block3Template, {
    working_memory_turns: formatWorkingMemory(workingMemory),
  });

  // --- Block 4 (dynamic) ---
  const block4Template = getPrompt("ka/block_4_dynamic").content;
  const block4Vars: Record<string, string> = {
    intent_type: block4.intent.intent,
    intent_action: block4.intent.action ?? "(unspecified)",
    intent_target: block4.intent.target ?? "(none)",
    intent_epicness: block4.intent.epicness.toFixed(2),
    intent_special_conditions: formatSpecialConditions(block4.intent.special_conditions),
    outcome_verdict: formatOutcome(block4.outcome),
    active_composition_mode: block4.active_composition_mode ?? "standard",
    arc_phase_craft:
      block4.arc_phase_craft ?? "(no beat-craft guidance for this phase — narrate by judgment)",
    retrieval_budget: formatRetrievalBudget(block4.retrieval_budget),
    player_message: block4.player_message,
    scene_location: block4.scene?.location ?? "(unknown)",
    scene_situation: block4.scene?.situation ?? "(unknown)",
    scene_time_context: block4.scene?.time_context ?? "(unknown)",
    scene_present_npcs: formatPresentNpcs(block4.scene?.present_npcs),
    arc_current: block4.arc_state?.current_arc ?? "(Director has not set one)",
    arc_phase: block4.arc_state?.arc_phase ?? "(unplanned)",
    arc_tension: (block4.arc_state?.tension_level ?? 0.5).toFixed(2),
    active_foreshadowing: formatForeshadowing(block4.active_foreshadowing),
    director_notes: block4.director_notes ?? "(none this turn)",
    player_overrides: formatOverrides(block4.player_overrides),
    sakuga_injection: block4.sakuga_injection ?? "",
    style_drift_directive: block4.style_drift_directive ?? "",
    vocabulary_freshness_advisory: block4.vocabulary_freshness_advisory ?? "",
  };
  const block4Rendered = substitute(block4Template, block4Vars);

  return {
    block1,
    block2,
    block3,
    block4: block4Rendered,
  };
}
