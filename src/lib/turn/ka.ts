import type { Db } from "@/lib/db";
import { SAKUGA_FRAGMENTS } from "@/lib/ka/fragments";
import { COMMIT_SCENE_TOOL, callProbe, extractCommitScene, streamNarration } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import type { Conte } from "@/lib/types/conte";
import { CommitScene } from "@/lib/types/sidecar";
import type { TurnEffort } from "@/lib/types/turn";
import type { MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import type { LadderStep } from "./degrade";
import {
  KA_RESEARCH_TOOLS,
  executeGetTurnNarrative,
  executeRecallScene,
  executeSearchLore,
} from "./tools";

/**
 * Phase B — the KeyAnimator (blueprint §5.1, §5.7): ONE narration-tier
 * call holds the pen. Blocks 1–3 arrive cached; the conte is Block 4,
 * rendered into the user message. Free prose streams to the player; the
 * typed sidecar arrives as the mandatory commit_scene trailer, with a
 * probe-tier reconstruction fallback (logged). Research round-trips are
 * budgeted by the turn contract and are §5.6's guaranteed warm cache reads.
 */

/**
 * The KA's standing contract — stable text, part of Block 1 so it caches
 * with the Settei. Craft pressure lives in the Settei itself; this is the
 * EXECUTION contract: agency, the trailer, research discipline.
 */
export const KA_CONTRACT = `## The pen

You are the key animator: the one writer. Everything before this section is your standing brief — the story so far, the working window, and the style charter whose pressures are not suggestions. The storyboard for THIS scene arrives with the player's turn.

Non-negotiables:
- PLAYER AGENCY: you write the world's half of the scene. Never decide, speak, or act FOR the player character beyond what their stated action implies. At a genuine decision point — a fork the player would want to weigh — present it and STOP mid-scene. Do not resolve it for them.
- THE DIE ALREADY FELL: the storyboard carries the judged outcome and its arithmetic. Narrate THAT outcome — never soften a failure into a win, never tax a success the judgment didn't tax. Failure is part of the story now.
- RESEARCH, THEN WRITE: you may have research tools this turn (budgeted). Use them BEFORE the prose when the scene touches canon or past detail you are not sure of; never mid-prose. If the budget is spent, write from what you have and keep uncertain specifics out of frame.
- THE TRAILER: when the prose is complete, call commit_scene exactly once — cast changes (admission is deliberate; most scenes admit no one), decision_point, seed mentions, notable beats. Never mention the tool, the storyboard, or any machinery in the prose.
- Prose is the ONLY thing the player sees. No headers, no meta, no summaries of what you did.

The scene is not finished when the prose ends. It is finished when commit_scene is called. A long scene makes the trailer easy to forget — end the prose, then IMMEDIATELY call commit_scene, every scene, without exception. (Measured 2026-07-11: half of long-form scenes dropped it; the fallback reconstruction is lossier than your own record.)`;

/** Deterministic Block-4 rendering: the conte as the KA's storyboard. */
export function renderConte(conte: Conte, playerInput: string): string {
  const lines: string[] = ["# Storyboard (this scene only)"];
  lines.push(`Player action: ${playerInput}`);
  lines.push(
    `Turn ${conte.turn_id} · tier ${conte.tier}${conte.degraded ? " · DEGRADED (minimal brief)" : ""}`,
  );

  if (conte.outcome) {
    const o = conte.outcome;
    const roll = conte.mechanics?.rolls[0];
    lines.push(
      `\n## Judged outcome (already rolled — narrate this)\n${o.success_level.toUpperCase()} vs DC ${o.difficulty_class}${roll ? ` (d20: ${roll.rolled}${roll.modifier ? ` ${roll.modifier >= 0 ? "+" : ""}${roll.modifier}` : ""} = ${roll.total})` : ""}; weight ${o.narrative_weight}.`,
    );
    if (o.modifiers.length > 0) lines.push(`Modifiers: ${o.modifiers.join(", ")}`);
    if (o.cost) lines.push(`Cost to honor: ${o.cost}`);
    if (o.consequence) lines.push(`Consequence in play: ${o.consequence}`);
    lines.push(`Reasoning: ${o.rationale}`);
  }
  if (conte.mechanics && conte.mechanics.resource_spends.length > 0) {
    lines.push(
      `Resource spends (already deducted): ${conte.mechanics.resource_spends.map((s) => `${s.amount} ${s.resource}`).join(", ")}`,
    );
  }
  if (conte.mechanics?.combat_results) {
    lines.push(`\n## Combat pre-resolution\n${conte.mechanics.combat_results}`);
  }
  if (conte.charter_amendments) {
    lines.push(
      `\n## Charter amendments (fresh corrections — obey over the standing charter)\n${conte.charter_amendments}`,
    );
  }
  if (conte.scene_shape_directive) {
    lines.push(`\n${conte.scene_shape_directive}`);
  }
  if (conte.pacer_beat) {
    const p = conte.pacer_beat;
    lines.push(
      `\n## Beat\n${p.beat_classification}${p.tone ? ` · tone: ${p.tone}` : ""}${p.escalation_target ? ` · escalating toward: ${p.escalation_target}` : ""} (${p.strength})`,
    );
    if (p.must_reference.length > 0) lines.push(`Must reference: ${p.must_reference.join("; ")}`);
    if (p.avoid.length > 0) lines.push(`Avoid: ${p.avoid.join("; ")}`);
    if (p.foreshadowing_hint) lines.push(`Foreshadow, lightly: ${p.foreshadowing_hint}`);
  }
  if (conte.canonicality_directives.length > 0) {
    lines.push(`\n## Canonicality\n${conte.canonicality_directives.join("\n")}`);
  }
  if (conte.hard_constraints.length > 0) {
    lines.push(
      `\n## Hard constraints (inviolable)\n${conte.hard_constraints.map((c) => `- ${c}`).join("\n")}`,
    );
  }
  if (conte.memories.length > 0) {
    lines.push(
      `\n## What matters from memory\n${conte.memories.map((m) => `- [${m.layer}, turn ${m.turn_id}] ${m.content}`).join("\n")}`,
    );
  }
  if (conte.canon_chunks.length > 0) {
    lines.push(
      `\n## Canon in play\n${conte.canon_chunks.map((c) => `- [${c.source_profile_id}/${c.page_type}] ${c.content.slice(0, 400)}`).join("\n")}`,
    );
  }
  if (conte.entity_cards.length > 0) {
    lines.push(`\n## Present cast\n${conte.entity_cards.map((e) => `- ${e}`).join("\n")}`);
  }
  if (conte.spotlight_hints.length > 0) {
    lines.push(`Spotlight: ${conte.spotlight_hints.join("; ")}`);
  }
  if (conte.active_consequences.length > 0) {
    lines.push(
      `\n## Active consequences (the world remembers)\n${conte.active_consequences.map((c) => `- ${c}`).join("\n")}`,
    );
  }
  if (conte.callbacks.length > 0) {
    lines.push(
      `\n## Callback opportunities (never obligations)\n${conte.callbacks.map((c) => `- ${c}`).join("\n")}`,
    );
  }
  if (conte.world_assertion_notes.length > 0) {
    lines.push(
      `\n## Player world-building to integrate\n${conte.world_assertion_notes.join("\n")}`,
    );
  }
  if (conte.style_drift_directive) lines.push(`\nStyle: ${conte.style_drift_directive}`);
  if (conte.vocab_freshness_advisory) lines.push(`Vocabulary: ${conte.vocab_freshness_advisory}`);
  if (conte.sakuga_mode) {
    lines.push(`\n## Sakuga (${conte.sakuga_mode})\n${SAKUGA_FRAGMENTS[conte.sakuga_mode]}`);
  }
  if (conte.research_findings.length > 0) {
    lines.push(`\n## Research findings\n${conte.research_findings.join("\n")}`);
  }
  lines.push("\nWrite the scene.");
  return lines.join("\n");
}

export interface KAResult {
  prose: string;
  sidecar: CommitScene | null;
  /** Trailer was missing and the probe reconstructed it (§5.7, logged). */
  trailerFallback: boolean;
  fallbackUsed: boolean;
  refused: boolean;
  researchCalls: number;
  costUsd: number;
}

export interface KAEvent {
  type: "prose" | "staging";
  text: string;
}

function researchBudget(base: number, ladderSteps: LadderStep[]): number {
  if (ladderSteps.includes("cap_research_0")) return 0;
  if (ladderSteps.includes("cap_research_2")) return Math.min(2, base);
  return base;
}

/**
 * Run Phase B: stream prose, execute budgeted research round-trips, end on
 * the commit_scene trailer (or reconstruct it via probe). The prior
 * exchanges live in Block 3 — the message list here is just this turn.
 */
export async function runKeyAnimator(
  db: Db,
  args: {
    campaignId: string;
    turnNumber: number;
    conte: Conte;
    playerInput: string;
    system: TextBlockParam[];
    selection: TierSelection;
    effort: TurnEffort;
    maxTokens: number;
    kaResearchCalls: number;
    ladderSteps: LadderStep[];
    profileIds: string[];
    emit: (e: KAEvent) => void;
  },
): Promise<KAResult> {
  const budget = researchBudget(args.kaResearchCalls, args.ladderSteps);
  const tools = budget > 0 ? [COMMIT_SCENE_TOOL, ...KA_RESEARCH_TOOLS] : [COMMIT_SCENE_TOOL];

  const messages: MessageParam[] = [
    { role: "user", content: renderConte(args.conte, args.playerInput) },
  ];

  let prose = "";
  let researchCalls = 0;
  let costUsd = 0;
  let fallbackUsed = false;

  // Research loop: each round streams; commit_scene (or plain end) exits.
  for (let round = 0; round < budget + 2; round++) {
    const { stream, done } = streamNarration({
      name: "ka_narration",
      selection: args.selection,
      system: args.system,
      messages,
      // Adaptive thinking spends from this budget too. 16k headroom, not 8k:
      // the M1 soak caught a sakuga scene truncating when a hard beat's
      // thinking alone ate the 8k (fourth sighting of the class — conductor
      // 8k, OSP 16k, C5 KA, now sakuga). A ceiling, never a target (§5.5).
      maxTokens: args.maxTokens + 16_000,
      effort: args.effort === "xhigh" ? "xhigh" : args.effort === "low" ? "low" : "high",
      tools,
      campaignId: args.campaignId,
      turnNumber: args.turnNumber,
    });
    stream.on("text", (t) => {
      prose += t;
      args.emit({ type: "prose", text: t });
    });
    const result = await done();
    costUsd += result.costUsd;
    fallbackUsed = fallbackUsed || result.fallbackUsed;
    if (result.refused) {
      return {
        prose: "",
        sidecar: null,
        trailerFallback: false,
        fallbackUsed,
        refused: true,
        researchCalls,
        costUsd,
      };
    }

    // A truncated response (adaptive thinking + prose overran max_tokens) is
    // NOT a forgotten trailer: the prose is cut mid-sentence, so committing it
    // would freeze half a scene into the permanent episodic record. Fail the
    // attempt so the Phase-B retry loop re-renders instead of fabricating a
    // sidecar over the cut.
    if (result.message.stop_reason === "max_tokens") {
      throw new Error("narration truncated (max_tokens) — retrying the scene");
    }

    const sidecar = extractCommitScene(result.message);
    if (sidecar) {
      return {
        prose,
        sidecar,
        trailerFallback: false,
        fallbackUsed,
        refused: false,
        researchCalls,
        costUsd,
      };
    }

    const toolUses = result.message.content.filter((b) => b.type === "tool_use");
    const researchUses = toolUses.filter((b) => b.type === "tool_use" && b.name !== "commit_scene");
    if (result.message.stop_reason !== "tool_use" || researchUses.length === 0) {
      break; // prose ended without a (valid) trailer — probe fallback below
    }

    messages.push({ role: "assistant", content: result.message.content });
    // Every tool_use in the assistant message MUST get a tool_result or the
    // next request 400s — including a commit_scene block whose input failed
    // validation (extractCommitScene returned null above) and any research
    // tool. The invalid trailer gets a nudge to re-emit it cleanly.
    const results = [];
    for (const block of toolUses) {
      if (block.type !== "tool_use") continue;
      if (block.name === "commit_scene") {
        results.push({
          type: "tool_result" as const,
          tool_use_id: block.id,
          content:
            "That commit_scene call was malformed. Finish the scene if unfinished, then call commit_scene once more with valid fields (notable_beats needs 1–3 entries).",
          is_error: true,
        });
        continue;
      }
      let output: string;
      if (researchCalls >= budget) {
        output = "Research budget exhausted — write the scene from what you have.";
      } else {
        researchCalls += 1;
        args.emit({ type: "staging", text: "checking the records" });
        try {
          output =
            block.name === "search_lore"
              ? await executeSearchLore(
                  db,
                  args.profileIds,
                  block.input as { query: string; page_type?: string },
                  { campaignId: args.campaignId, turnNumber: args.turnNumber },
                )
              : block.name === "recall_scene"
                ? await executeRecallScene(
                    db,
                    args.campaignId,
                    block.input as { turn_number: number },
                  )
                : block.name === "get_turn_narrative"
                  ? await executeGetTurnNarrative(
                      db,
                      args.campaignId,
                      block.input as { from_turn: number; to_turn: number },
                    )
                  : `unknown tool ${block.name}`;
        } catch (err) {
          output = `Tool failed (${err instanceof Error ? err.message : "error"}) — write from what you have.`;
        }
      }
      results.push({ type: "tool_result" as const, tool_use_id: block.id, content: output });
    }
    messages.push({ role: "user", content: results });
  }

  // §5.7: missing trailer → probe-tier reconstruction, logged.
  console.warn("[ka] commit_scene trailer missing — probe fallback", {
    campaignId: args.campaignId,
    turnNumber: args.turnNumber,
  });
  let sidecar: CommitScene | null = null;
  try {
    sidecar = await callProbe(args.selection, {
      name: "sidecar_fallback",
      schema: CommitScene,
      campaignId: args.campaignId,
      turnNumber: args.turnNumber,
      system:
        "Reconstruct the scene sidecar from narration prose. Cast admission is DELIBERATE — most scenes admit no one to the catalog; only name a cast change when the scene clearly introduces a lasting character or dismisses one. decision_point only when the scene ends on a genuine fork presented to the player.",
      prompt: prose.slice(-6_000) || "(empty scene)",
      maxTokens: 2_000,
    });
  } catch (err) {
    console.error("[ka] sidecar fallback probe failed", err);
  }
  return {
    prose,
    sidecar,
    trailerFallback: true,
    fallbackUsed,
    refused: false,
    researchCalls,
    costUsd,
  };
}
