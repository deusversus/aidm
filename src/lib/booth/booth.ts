import { assembleForCampaign } from "@/lib/blocks/campaign";
import type { Db } from "@/lib/db";
import { campaigns, overrides, pencilMarks } from "@/lib/db/schema";
import { callJudgment, callProbe, streamNarration } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import {
  BOOTH_EXCHANGE_CAP,
  type BoothExchange,
  BoothResolution,
  type BoothResponder,
  BoothRoute,
  BoothState,
} from "@/lib/types/booth";
import { PremiseContract } from "@/lib/types/premise";
import { and, eq } from "drizzle-orm";

/**
 * The channel responders (blueprint §5.4, C9): the meta booth and the
 * override channel. See types/booth.ts for the doctrine. Wired from the
 * turn runtime's channel path — a channel turn streams the responder's
 * prose through the SAME event bus a story turn uses, but its row keeps
 * status "channel" and never enters the story window.
 */

export const BOOTH_PROVENANCE = "meta_booth";

/** campaigns.tier_models → TierSelection, falling back to the infra default (director.ts pattern). */
function resolveSelection(tierModels: unknown): TierSelection {
  const parsed = TierSelection.safeParse(tierModels);
  return parsed.success ? parsed.data : DEV_TIER_SELECTION;
}

/** Compact, one-line-per-turn booth transcript for prompts: PLAYER / STUDIO(persona). */
function formatTranscript(exchanges: BoothExchange[]): string {
  return exchanges
    .map((e) =>
      e.role === "player" ? `PLAYER: ${e.text}` : `STUDIO(${e.responder ?? "director"}): ${e.text}`,
    )
    .join("\n");
}

const BOOTH_ROUTER_SYSTEM = `You route ONE out-of-fiction booth message from a player to exactly one studio responder — never both.
- "director": craft, direction, pacing, arcs, seeds, structure, stakes — anything about what the STORY is doing, should do, or where it is going.
- "ka": prose, voice, style, word choice, tone-on-the-page — anything about HOW the writing reads.
An EXPLICIT summon in the player's own words WINS outright over topic classification: "ask the director" / "let me talk to the director" → director; "let me talk to the writer" / "talk to the animator" / "ask the writer/animator" → ka.
Return the single responder and a one-line reason.`;

const BOOTH_RESOLUTION_SYSTEM = `You are closing an out-of-fiction booth conversation between a player and the studio. Extract ONLY the durable calibrations the player actually SETTLED — not everything discussed, not studio suggestions the player did not take up.
- marks: standing craft/voice/axis guidance the player wants carried forward (the writer's #4 signal). kind = "axis" for a premise-dial nudge, "voice_feature" for a prose-voice fingerprint, "craft_note" for general craft direction. Each carries a topic, a direction, and evidence (a short quote or paraphrase of what the player said).
- overrides: standing RULES the player explicitly laid down in the booth (rare — most rules go through the override channel). Include only a rule the player clearly declared as binding.
- summary: one line naming what, if anything, was decided.
Empty arrays are a valid resolution: a chat that calibrated nothing resolves to empty marks and overrides with a summary that says so.`;

/** The persona rides as a MESSAGE, never a system mutation (§5.4: the cached prefix stays byte-identical across responders). */
function personaFraming(responder: BoothResponder, contract: PremiseContract): string {
  if (responder === "director") {
    return [
      contract.active.voice.director_personality,
      "",
      "You are the Director — this campaign's showrunner (§7.1), stepping OUT of the fiction to talk shop with your co-author in the meta booth. Be candid about craft, arcs, pacing, and what the story is doing. This is a studio conversation, not a scene.",
    ].join("\n");
  }
  return "You are the Key Animator — the writer who holds the pen for this campaign, stepping OUT of the fiction to talk with your co-author in the meta booth about prose, voice, and how the story reads on the page. This is a studio conversation, not a scene.";
}

/**
 * One booth exchange: route (probe — explicit summons win over content
 * classification), respond (streamNarration over the cached blocks-1–3
 * prefix; persona as a MESSAGE, §5.4), persist the exchange pair onto
 * campaigns.booth_state, and CLOSE the booth when the responder resolves it
 * or the cap is reached (cap: instruct the responder to emit a resolution
 * summary in its reply, then close). Closing runs resolveBooth.
 *
 * `emit` receives prose deltas as they stream; the returned reply is the
 * full text (the runtime persists it on the channel turn row for replay).
 *
 * At M1 only the cap and the runtime's story-turn close end the booth: this
 * function never auto-detects "resolved" language in the reply.
 */
export async function runBoothExchange(
  db: Db,
  campaignId: string,
  turnNumber: number,
  playerInput: string,
  emit: (text: string) => void,
): Promise<{ reply: string; responder: BoothResponder; closed: boolean; summary?: string }> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) throw new Error(`runBoothExchange: campaign ${campaignId} not found`);
  const contract = PremiseContract.parse(campaign.premiseContract);
  const selection = resolveSelection(campaign.tierModels);
  const state = BoothState.parse(campaign.boothState ?? {});

  // §5.7 crash-replay idempotency (C9 audit): the exchange pair persists in
  // ONE update, so a studio entry at this turn means this exchange already
  // ran — replay the stored reply instead of re-running the responder
  // (re-billing) and duplicating the pair. (A crash exactly between a
  // cap-close and the runtime's status write re-runs as a FRESH booth —
  // bounded: the old booth already resolved and wrote its marks.)
  const replayed = state.exchanges.find((e) => e.role === "studio" && e.at_turn === turnNumber);
  if (replayed) {
    emit(replayed.text);
    return {
      reply: replayed.text,
      responder: replayed.responder ?? "director",
      closed: false,
    };
  }

  // (2) ROUTE — probe tier; explicit summon wins; failure defaults to
  // director with a warn (a routing failure must never block the booth).
  const recent = state.exchanges.slice(-4);
  const routerContext =
    recent.length > 0 ? `Recent booth context:\n${formatTranscript(recent)}\n\n` : "";
  const routerPrompt = `${routerContext}New player message:\n${playerInput}`;
  const route = await callProbe(selection, {
    name: "booth_router",
    schema: BoothRoute,
    campaignId,
    turnNumber,
    system: BOOTH_ROUTER_SYSTEM,
    prompt: routerPrompt,
  }).catch((err) => {
    console.warn(
      `[booth] router failed — defaulting to director: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { responder: "director" as const, reason: "router failure default" };
  });
  const responder = route.responder;

  // Cap accounting: this player message is exchange #(priorPlayer + 1). At the
  // cap the responder must emit a resolution summary and the booth closes.
  const priorPlayerExchanges = state.exchanges.filter((e) => e.role === "player").length;
  const atCap = priorPlayerExchanges + 1 >= BOOTH_EXCHANGE_CAP;

  // (3) RESPOND — streamNarration over the cached blocks 1–3 prefix (§5.4:
  // read the cache, never rebuild it). The persona differs only by a framing
  // MESSAGE, so the cached system prefix stays byte-identical across
  // responders (the per-model prompt cache is what §5.4's mandate reuses).
  const blocks = await assembleForCampaign(db, campaignId);
  if (!blocks) {
    console.warn(
      `[booth] no assembled blocks for ${campaignId} — responding without the cached prefix`,
    );
  }
  const transcript = formatTranscript(state.exchanges);
  const parts = [personaFraming(responder, contract)];
  if (transcript) parts.push(`## Booth so far\n${transcript}`);
  parts.push(`## New message from your co-author\nPLAYER: ${playerInput}`);
  parts.push(
    "Reply out-of-fiction: no scene prose, no narration — the concise, candid voice of the studio room. When the matter is genuinely settled, say so naturally.",
  );
  if (atCap) {
    parts.push("This is the final exchange — emit a resolution summary of what was decided.");
  }
  const userMessage = parts.join("\n\n");

  const { stream, done } = streamNarration({
    name: "booth_responder",
    selection,
    system: blocks?.system ?? [],
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 4_000,
    // No trailer: a booth reply is player-facing conversation, not a scene.
    // Empty tools drops tool_choice (an empty tools array is an API 400).
    tools: [],
    campaignId,
    turnNumber,
  });
  stream.on("text", (t) => emit(t));
  const result = await done();
  // A refused or empty reply must not persist as a hollow exchange (C9
  // audit): throw — the runtime's catch lands the turn with the apologetic
  // acknowledgement and the booth state stays untouched for a clean retry.
  if (result.refused) throw new Error("booth responder refused");
  const reply = result.prose;
  if (!reply.trim()) throw new Error("booth responder returned empty prose");

  // (4) PERSIST — append the exchange pair; stamp opened_at_turn once (on the
  // first exchange, when the state was empty). Single update.
  const openedAtTurn = state.exchanges.length === 0 ? turnNumber : state.opened_at_turn;
  const nextState: BoothState = {
    opened_at_turn: openedAtTurn,
    exchanges: [
      ...state.exchanges,
      { role: "player", text: playerInput, at_turn: turnNumber },
      { role: "studio", text: reply, responder, at_turn: turnNumber },
    ],
  };
  await db
    .update(campaigns)
    .set({ boothState: nextState, updatedAt: new Date() })
    .where(eq(campaigns.id, campaignId));

  // (5) CLOSE at cap — extract calibrations + clear the state, then report the
  // resolution (its summary source is the reply itself).
  if (atCap) {
    await closeBoothIfOpen(db, campaignId, turnNumber);
    return { reply, responder, closed: true, summary: reply };
  }
  return { reply, responder, closed: false };
}

/**
 * Close an open booth (no-op when none): ONE judgment call extracts the
 * conversation's durable outcomes (BoothResolution) → pencil marks (writer
 * #4, provenance meta_booth, confidence 0.9) and/or override rows → clear
 * booth_state. Called at cap by runBoothExchange, and by the runtime when a
 * STORY turn lands while the booth is open (returning to the fiction closes
 * the booth — its calibrations must not wait). Extraction failure still
 * clears the state with a warn: a lost resolution is a lost calibration,
 * never a wedged turn.
 */
export async function closeBoothIfOpen(
  db: Db,
  campaignId: string,
  turnNumber: number,
): Promise<void> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return;
  const state = BoothState.parse(campaign.boothState ?? {});
  if (state.exchanges.length === 0) return; // nothing open

  const selection = resolveSelection(campaign.tierModels);
  let resolution: BoothResolution | null = null;
  try {
    resolution = await callJudgment(selection, {
      name: "booth_resolution",
      schema: BoothResolution,
      campaignId,
      turnNumber,
      effort: "medium",
      maxTokens: 6_000,
      system: BOOTH_RESOLUTION_SYSTEM,
      prompt: `Booth transcript:\n${formatTranscript(state.exchanges)}`,
    });
  } catch (err) {
    console.warn(
      `[booth] resolution extraction failed — clearing without calibration: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (resolution) {
    if (resolution.marks.length > 0) {
      await db.insert(pencilMarks).values(
        resolution.marks.map((m) => ({
          campaignId,
          kind: m.kind,
          topic: m.topic,
          direction: m.direction,
          evidence: m.evidence,
          turnId: turnNumber,
          provenance: BOOTH_PROVENANCE,
          confidence: 0.9,
        })),
      );
    }
    if (resolution.overrides.length > 0) {
      await db.insert(overrides).values(
        resolution.overrides.map((content) => ({
          campaignId,
          content,
          active: true,
          turnId: turnNumber,
          provenance: BOOTH_PROVENANCE,
          confidence: 1,
        })),
      );
    }
  }

  // Clear regardless: extraction failure loses calibration, never wedges a turn.
  await db
    .update(campaigns)
    .set({ boothState: null, updatedAt: new Date() })
    .where(eq(campaigns.id, campaignId));
}

/**
 * The override channel (§5.4, §7.4 — "compliance with minimal ceremony"):
 * OVERRIDE_COMMAND and OP_COMMAND inputs mint a standing override row
 * (active, provenance "player_override", confidence 1) injected every turn
 * including douga (the M0 reader already exists in Layout). Returns the
 * short player-facing acknowledgement line. No model call — minimal ceremony.
 */
export async function mintOverride(
  db: Db,
  campaignId: string,
  turnNumber: number,
  content: string,
): Promise<{ acknowledgement: string }> {
  // §5.7 crash-replay idempotency (C9 audit): a replayed dispatch repeats
  // the SAME content — dedupe on it. The key must be content-aware (C9
  // re-audit): the Studio-notes panel mints at the campaign's latest turn,
  // so a turn-only key silently dropped a SECOND distinct rule added
  // without an intervening story turn — the player's highest-authority
  // input vanishing behind a false success ack.
  const [existing] = await db
    .select({ id: overrides.id })
    .from(overrides)
    .where(
      and(
        eq(overrides.campaignId, campaignId),
        eq(overrides.turnId, turnNumber),
        eq(overrides.provenance, "player_override"),
        eq(overrides.content, content),
      ),
    )
    .limit(1);
  if (!existing) {
    await db.insert(overrides).values({
      campaignId,
      content,
      active: true,
      turnId: turnNumber,
      provenance: "player_override",
      confidence: 1,
    });
  }
  return {
    acknowledgement: `Standing rule recorded: "${content}" — in force from the next scene.`,
  };
}
