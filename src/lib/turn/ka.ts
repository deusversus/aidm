import type { Db } from "@/lib/db";
import { SAKUGA_FRAGMENTS } from "@/lib/ka/fragments";
import { STRUCTURED_SMALL } from "@/lib/llm/budgets";
import { callProbe, extractCommitScene, streamNarration } from "@/lib/llm/calls";
import type { TierSelection } from "@/lib/llm/tiers";
import type { Conte } from "@/lib/types/conte";
import { CommitScene, clampCommitScene } from "@/lib/types/sidecar";
import type { TurnEffort } from "@/lib/types/turn";
import type {
  ContentBlockParam,
  Message,
  MessageParam,
  TextBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { LadderStep } from "./degrade";
import { KA_TOOLS, executeGetTurnNarrative, executeRecallScene, executeSearchLore } from "./tools";

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
- THE WORLD MOVES: agency's twin, never its casualty. The world's half is ALIVE — NPCs have goals, secrets, and reactions that are not responses to the player; they act between scenes and within them; consequences arrive on their own schedule whether or not anyone is watching. You never decide FOR the player — and you always leave them something to decide ABOUT.
- THE DIE ALREADY FELL: the storyboard carries the judged outcome and its arithmetic. Narrate THAT outcome — never soften a failure into a win, never tax a success the judgment didn't tax. Failure is part of the story now.
- RESEARCH, THEN WRITE: you may have research tools this turn (budgeted). Use them BEFORE the prose when the scene touches canon or past detail you are not sure of; never mid-prose. If the budget is spent, write from what you have and keep uncertain specifics out of frame.
- THE TRAILER: your turn does not end when the prose ends. It ends when you call commit_scene. Write the scene, then — in the SAME turn, with no closing remark and nothing between — call commit_scene exactly once: cast changes (admission is deliberate; most scenes admit no one), decision_point, seed mentions, notable beats. When decision_point is true, ALSO include suggested_moves: 2-3 short premise-true next moves the player could take (they render as dismissible chips beside the scene, never in your prose); omit them when it is false. The final line of a scene FEELS like the end of a turn — it is not; stopping there means the scene's own record gets reconstructed by a smaller model that never read your storyboard. Never mention the tool, the storyboard, or any machinery in the prose.
- Prose is the ONLY thing the player sees. No headers, no meta, no summaries of what you did.

## The camera

Prose is a camera and you are always operating it. Every scene you are choosing the framing (close on a face for the monologue, wide for the battlefield), the coverage (whose eyes, what is in frame, what is deliberately held out of it), and the edit — the cut to elsewhere, the intercut that carries simultaneity, the flashback, the sound bridge, the cold open. Your player was raised on anime and manga: they follow sophisticated visual grammar without effort, and they will follow yours IF the prose gives the signals the screen gives free. The whole toolkit is yours — WHICH of it this story wants, the charter above has already decided; the camera serves its pressures like everything else (a linear premise gets no flashbacks however legible). The one law is legibility of the edit: at every moment the player knows where the camera is, WHEN it is, and whose eyes they look through — or is unsure because you chose that, briefly, on purpose. A cut in place, time, or point of view is visible AT the cut, entry and exit, never discoverable three sentences downstream. And an established channel keeps its contract: a device this campaign has taught the player to read one way — a live readout, a System window, a letter — never silently carries a different tense or speaker; when it must do double duty, mark the variant so the cut shows. (Live, 2026-07-17: a first-life death flashback arrived in the same readout format five turns had established as present-tense tactical reads — the player experienced their own backstory as a scene they were never in.)

## The exit

How a scene ends is a choice you are always making, and the house habit is the wrong one (measured across twelve real turns, 2026-07-20): this studio writes beautiful closes that KILL the scene's own pressure — the mystery introduced two paragraphs up goes "quiet," the new arrival is "forgotten. Mostly." A musically resolved cadence is fine prose; at a table it is the story declining to move. The law of the exit:

- PRESSURE SURVIVES THE SCENE. What a scene introduces — a hook, an arrival, a question, a threat — leaves the scene still alive unless the player resolved it. A hook may be paid off; it is never faded out.
- END ON THE THING THAT ASKS. The strong closes land on what demands a response: the arrival mid-step, the discovery as it lands, the fork presented (and stopped), the clock visibly advancing. Not on the settling-down after.
- THE PLAYER'S INPUT IS THE FLOOR, NEVER THE CEILING — and the entrance is THEIRS. The player owns the scene's entrance; the world owns its exit. Render the heart of what they authored ON SCREEN, weighted the way THEY weighted it, before the world makes its move — compressing their authored hours into backstory and opening at the far edge of their input erases them from their own turn (live, 2026-07-20: a player wrote three loving hours of language-learning and one clause about opening a book; the reply opened on an emptied room and the book — a beautiful scene, one scene too late). A rich turn is not permission to add nothing, and it is not permission to skip to your addition: their half first, on screen; then the world's move; then the exit. A bare "continue" and a paragraph of player authorship earn the same world initiative.
- NEW pressure or ADVANCED pressure — never the same fork re-worn. Re-posing a standing dilemma in fresh imagery is stasis in motion's uniform; if the old question closes the scene again, something about it must have moved.
- Rest is a register, not a default. Where the charter runs quiet, scenes may breathe and settle — that is the premise's licensed grammar, and even then one live thread stays visibly open. The charter above decides which story this is; you do not decide it scene by scene out of cadence.

The scene is not finished when the prose ends. It is finished when commit_scene is called. A beautiful last line is the strongest pull toward ending the turn early — resist it: end the prose, then IMMEDIATELY call commit_scene, every scene, without exception. (Measured 2026-08-01 across fifteen consecutive live turns: the trailer landed on ZERO of them — every scene stopped on its last line and the record was reconstructed second-hand, once cataloguing a living character as a dead one.)`;

/**
 * Deterministic Block-4 rendering: the conte as the KA's storyboard.
 *
 * `researchBudget` rides here, in the volatile block, because the tool array
 * can no longer carry it (M2R5 C1 — the array is constant so the cached prefix
 * survives a douga beat). Stating the allowance is what keeps a zero-budget
 * turn from spending a whole round discovering the refusal.
 */
export function renderConte(conte: Conte, playerInput: string, researchBudget?: number): string {
  const lines: string[] = ["# Storyboard (this scene only)"];
  lines.push(`Player action: ${playerInput}`);
  lines.push(
    `Turn ${conte.turn_id} · tier ${conte.tier}${conte.degraded ? " · DEGRADED (minimal brief)" : ""}`,
  );
  if (researchBudget !== undefined) {
    lines.push(
      researchBudget > 0
        ? `Research allowance this scene: ${researchBudget} tool call(s), before the prose.`
        : "Research allowance this scene: NONE. Write from what you hold — a research call this turn will be refused.",
    );
  }

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
    if (p.pacing_note) lines.push(`Drive: ${p.pacing_note}`);
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

/**
 * Which §5.7 path produced the sidecar. Only `native` is the KA's own record;
 * `continuation` is still the KA's own hand (same conversation, same context,
 * just asked again), while `probe` is a smaller model reading the prose back.
 * The distinction is load-bearing downstream: a non-native cast admission
 * enters the catalog demoted (M3 C1 — the reconstruction that filed a living
 * character as the dead sister).
 */
export type TrailerSource = "native" | "continuation" | "probe" | "none";

export interface KAResult {
  prose: string;
  sidecar: CommitScene | null;
  /** The native trailer was missing — continuation or probe ran (§5.7, logged). */
  trailerFallback: boolean;
  /** Which path actually produced the sidecar; recorded on the turn checkpoint. */
  trailerSource: TrailerSource;
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
 * What an over-budget research call gets back (M2R5 C1). The allowance is
 * stated in the conte; the tool array can no longer carry it without busting
 * the prefix, so the refusal carries it instead.
 */
export const RESEARCH_REFUSAL = "research budget exhausted — write the scene from what you hold.";

/**
 * The continuation round's whole prompt (M3 C1). Deliberately bare: the scene
 * is already in the conversation above it, so this asks for one thing and
 * offers no second thing to do.
 */
export const TRAILER_DEMAND =
  "The scene is written. Now call commit_scene with its sidecar — nothing else.";

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

  const messages: MessageParam[] = [
    { role: "user", content: renderConte(args.conte, args.playerInput, budget) },
  ];

  let prose = "";
  let researchCalls = 0;
  let costUsd = 0;
  let fallbackUsed = false;
  /** The message the loop exited on — the continuation round replays it. */
  let lastMessage: Message | null = null;
  // Whether lastMessage's content already rides in `messages` (the research
  // path pushes it and answers its tool_uses; the break path does not). The
  // continuation must never replay an appended turn: duplicate tool_use ids
  // are an API 400, and the cap-exhaustion exit hit exactly that (C1 audit).
  let lastAppended = false;

  // Research loop: each round streams; commit_scene (or plain end) exits. The
  // round cap still scales with the budget, so a zero-budget turn gets one
  // refused research round and one round to write — a stubborn model cannot
  // spin past the cap by asking again.
  for (let round = 0; round < budget + 2; round++) {
    const { stream, done } = streamNarration({
      name: "ka_narration",
      selection: args.selection,
      system: args.system,
      messages,
      // The craft-governed output budget (TURN_CONTRACTS.outputBudgetTokens).
      // Thinking headroom is added structurally by computeEffectiveMaxTokens
      // (calls.ts) — effort-scaled, clamped to the model's real ceiling — so
      // the old local +24k runaway pad is gone (M2R2 §6). Only produced tokens
      // bill (§5.5); a ceiling that fails a turn trims depth (§0 inversion),
      // which is why the pad, not this budget, absorbs the reasoning spend.
      maxTokens: args.maxTokens,
      effort: args.effort, // flat "high" from TURN_CONTRACTS since the §3 amendment (2026-08-01)
      tools: KA_TOOLS,
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
        trailerSource: "none",
        fallbackUsed,
        refused: true,
        researchCalls,
        costUsd,
      };
    }
    lastMessage = result.message;
    lastAppended = false;

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
        trailerSource: "native",
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
    lastAppended = true;
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
            "That commit_scene call was malformed — a field had the wrong shape or an out-of-vocabulary value. Finish the scene if unfinished, then call commit_scene once more with valid fields.",
          is_error: true,
        });
        continue;
      }
      let output: string;
      if (researchCalls >= budget) {
        // Refused, not executed: no DB work, no counter bump. The round it
        // consumed is the only cost, and the loop cap bounds those.
        output = RESEARCH_REFUSAL;
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

  // §5.7, step one: the continuation round (M3 C1). DIAGNOSED 2026-08-01 —
  // the trailer landed on 0 of 15 live turns, and the Langfuse record shows
  // why: every prose round ended `end_turn` with no tool_use block at all.
  // The model is not emitting a malformed trailer or forgetting mid-scene; it
  // treats the scene's last line as the end of its turn. So ask once more, on
  // the same conversation — the whole 29k prefix is warm, tool_choice is not
  // part of the tools/system cache key, and no prose is wanted, so the trailer
  // can simply be demanded. This is still the KA's own record: same context,
  // same model, same scene in view. The probe reconstruction below stays as
  // the net it was designed to be — now beneath a cheap accurate ask instead
  // of directly under the drop.
  let sidecar: CommitScene | null = null;
  let trailerSource: TrailerSource = "none";
  if (lastMessage) {
    // Post-prose, the surface would otherwise sit silent through a forced
    // high-effort call — the staging line keeps the long-turn case honest.
    args.emit({ type: "staging", text: "filing the scene" });
    console.warn("[ka] commit_scene trailer missing — asking once more", {
      campaignId: args.campaignId,
      turnNumber: args.turnNumber,
      stopReason: lastMessage.stop_reason,
    });
    // Every tool_use in the replayed assistant turn MUST get a result or the
    // request 400s. A commit_scene whose input failed validation reaches here
    // (the research branch above breaks before answering it), so this is also
    // where a malformed trailer finally gets its correction.
    const pending: ContentBlockParam[] = [];
    if (!lastAppended) {
      // The break path: the final assistant turn (and any tool_uses it
      // carried) has not been replayed yet — replay it, answering every
      // tool_use so the request is legal.
      for (const block of lastMessage.content) {
        if (block.type !== "tool_use") continue;
        pending.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "That call was not usable. Emit the trailer again, cleanly.",
          is_error: true,
        });
      }
      messages.push({ role: "assistant", content: lastMessage.content });
    }
    // The cap-exhaustion path: the turn is already in `messages`, its
    // tool_uses already answered with real results — only the demand rides.
    messages.push({
      role: "user",
      content:
        pending.length > 0 ? [...pending, { type: "text", text: TRAILER_DEMAND }] : TRAILER_DEMAND,
    });
    try {
      const { done } = streamNarration({
        name: "ka_trailer",
        selection: args.selection,
        system: args.system,
        messages,
        maxTokens: STRUCTURED_SMALL,
        // The SAME effort as the scene round, deliberately: effort rides the
        // cache key (M2R5), so a cheaper setting here would write a second
        // full prefix to save a few thinking tokens.
        effort: args.effort,
        tools: KA_TOOLS,
        toolChoice: { type: "tool", name: "commit_scene" },
        campaignId: args.campaignId,
        turnNumber: args.turnNumber,
      });
      const result = await done();
      costUsd += result.costUsd;
      fallbackUsed = fallbackUsed || result.fallbackUsed;
      sidecar = extractCommitScene(result.message);
      if (sidecar) trailerSource = "continuation";
    } catch (err) {
      // Never fatal: the continuation is an improvement on the net, not a
      // replacement for it. A rejected forced tool_choice, a stream failure,
      // a refusal — all fall through to the probe exactly as before.
      console.warn("[ka] trailer continuation failed — falling through to the probe", {
        campaignId: args.campaignId,
        turnNumber: args.turnNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (sidecar) {
    return {
      prose,
      sidecar,
      trailerFallback: true,
      trailerSource,
      fallbackUsed,
      refused: false,
      researchCalls,
      costUsd,
    };
  }

  // §5.7, the last net: probe-tier reconstruction, logged.
  console.warn("[ka] commit_scene trailer missing — probe fallback", {
    campaignId: args.campaignId,
    turnNumber: args.turnNumber,
  });
  try {
    sidecar = await callProbe(args.selection, {
      name: "sidecar_fallback",
      schema: CommitScene,
      campaignId: args.campaignId,
      turnNumber: args.turnNumber,
      system:
        "Reconstruct the scene sidecar from narration prose. Cast admission is DELIBERATE — most scenes admit no one to the catalog; only name a cast change when the scene clearly introduces a lasting character or dismisses one. decision_point only when the scene ends on a genuine fork presented to the player — and when it does, include suggested_moves: 2-3 short premise-true next moves grounded in the scene (omit them otherwise).",
      prompt: prose.slice(-6_000) || "(empty scene)",
      maxTokens: STRUCTURED_SMALL,
    });
    // Same ceilings as the native path (types/sidecar.ts): the probe writes
    // against the same stripped grammar, so its counts clamp rather than throw.
    if (sidecar) {
      sidecar = clampCommitScene(sidecar, {
        source: "probe",
        campaignId: args.campaignId,
        turnNumber: args.turnNumber,
      });
      trailerSource = "probe";
    }
  } catch (err) {
    console.error("[ka] sidecar fallback probe failed", err);
  }
  return {
    prose,
    sidecar,
    trailerFallback: true,
    trailerSource,
    fallbackUsed,
    refused: false,
    researchCalls,
    costUsd,
  };
}
