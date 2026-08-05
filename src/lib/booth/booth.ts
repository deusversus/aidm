import { assembleForCampaign } from "@/lib/blocks/campaign";
import type { Db } from "@/lib/db";
import { TASTE_NOTE_MAX, appendPlayerTaste } from "@/lib/db/helpers";
import { campaigns, overrides, pencilMarks, players } from "@/lib/db/schema";
import { identityKey } from "@/lib/entity-identity";
import {
  type CorrectionOutcome,
  type CorrectionTargetKind,
  PLAYER_CORRECTION_PROVENANCE,
  applyRecordCorrection,
} from "@/lib/ingestion/ingest";
import { CLASSIFY, PROSE_COMPOSER, STRUCTURED_RICH } from "@/lib/llm/budgets";
import { callJudgment, callProbe, streamNarration } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import { KA_TOOLS } from "@/lib/turn/tools";
import {
  BOOTH_CORRECTIONS_MAX,
  BOOTH_EXCHANGE_CAP,
  BOOTH_MARKS_MAX,
  BOOTH_OVERRIDES_MAX,
  type BoothExchange,
  BoothResolution,
  type BoothResponder,
  BoothRoute,
  BoothState,
  CorrectionComprehension,
  OverrideComprehension,
} from "@/lib/types/booth";
import { PremiseContract } from "@/lib/types/premise";
import { and, eq } from "drizzle-orm";

/**
 * The channel responders (blueprint §5.4, C9): the meta booth and the
 * override channel. See types/booth.ts for the doctrine. Wired from the
 * turn runtime's channel path — a channel turn streams the responder's
 * prose through the SAME event bus a story turn uses, but its row keeps
 * status "channel" and never enters the story window.
 *
 * The booth has three pens, each gated differently (M3R2 C4): pencil marks
 * and overrides at close, and — for the player's explicit statement that the
 * RECORD is wrong — M2-C3's retire-and-replace, filed mid-conversation so the
 * responder's acknowledgement can name a change that has actually landed.
 */

export const BOOTH_PROVENANCE = "meta_booth";

/** campaigns.tier_models → TierSelection, falling back to the infra default (director.ts pattern). */
function resolveSelection(tierModels: unknown): TierSelection {
  const parsed = TierSelection.safeParse(tierModels);
  return parsed.success ? parsed.data : DEV_TIER_SELECTION;
}

/** Drop surplus entries past an emission ceiling, loudly (types/booth.ts). */
function capBooth<T>(list: T[], max: number, field: string, campaignId: string): T[] {
  if (list.length <= max) return list;
  console.warn(`[booth] ${field} over its ${max}-item ceiling — clamped, resolution kept`, {
    campaignId,
    emitted: list.length,
  });
  return list.slice(0, max);
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
Return the single responder and a one-line reason.

Also set record_correction_signal: TRUE only when the message says an established RECORD is WRONG — "that hard line is the opposite of what I asked for", "you've got her name backwards", "the contract says X and I never said that". Wanting the story to go differently from here on is DIRECTION, not a correction: false. New world detail is an ADDITION, not a correction: false. The signal never changes the routing — both personas answer for the whole studio.`;

const BOOTH_RESOLUTION_SYSTEM = `You are closing an out-of-fiction booth conversation between a player and the studio. Extract ONLY the durable calibrations the player actually SETTLED — not everything discussed, not studio suggestions the player did not take up.
- marks (at most ${BOOTH_MARKS_MAX}): standing craft/voice/axis guidance the player wants carried forward (the writer's #4 signal). kind = "axis" for a premise-dial nudge, "voice_feature" for a prose-voice fingerprint, "craft_note" for general craft direction. Each carries a topic, a direction, and evidence (a short quote or paraphrase of what the player said).
- overrides (at most ${BOOTH_OVERRIDES_MAX}): standing RULES the player explicitly laid down in the booth (rare — most rules go through the override channel). Include only a rule the player clearly declared as binding.
- summary: one line naming what, if anything, was decided.
- player_taste_note (usually OMIT): ONE sentence, at most ${TASTE_NOTE_MAX} characters, about the PLAYER's durable taste — how they like their stories, not this character or campaign — only when the chat plainly revealed one ("I always want the quiet aftermath scene").
- corrections (at most ${BOOTH_CORRECTIONS_MAX}, usually OMIT): the player stated that the RECORD ITSELF is WRONG and said what it should say — a hard line written inverted, a fact stored backwards, a catalog entry that has someone wrong. A correction RETIRES established material; a fact that merely adds is not a correction, and neither is wanting the story to go differently (that is a mark or an override). target_kind "critical_fact" for the standing record (hard lines, the intensity contract, laws, always-true facts) or "entity" for a person/faction/place/thread dossier. target_hint quotes the wrong record's OWN words (critical_fact) or names the exact catalog entry (entity) — the engine binds by this text, and a hint that matches nothing files nothing. corrected_content is what the record must say instead, written as a record line. player_words is the player's VERBATIM statement making the claim — quote them, never the studio's reply agreeing with them; a correction the player did not say in so many words is dropped unread.
Empty arrays are a valid resolution: a chat that calibrated nothing resolves to empty marks and overrides with a summary that says so. Entries beyond a stated limit are discarded unread — keep the best ones.`;

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
 * The standing correction discipline both personas carry (M3R2 C4). The
 * founding incident was not a missing schema — it was a promise: the player
 * said a hard line was recorded inverted, the Writer agreed and said it would
 * be fixed, and no path existed by which anything could be. The engine now
 * files BEFORE the responder speaks, and tells it exactly what happened, so
 * "filed" is a report and never a hope.
 */
const BOOTH_CORRECTION_DISCIPLINE = [
  "The record is a real thing you can change and a real thing you can fail to change.",
  "When the player says the RECORD is wrong — a hard line inverted, a fact stored backwards —",
  "the engine files it before you reply and states the outcome under 'Record changes on this message'.",
  "Say what actually happened, in the player's own terms: when it was FILED, name the change",
  "('filed — the hard line now reads: ...'); when it was only HEARD, say so plainly with the",
  "reason, and tell them what would make it land. Never say a record was fixed, changed, updated,",
  "or noted-and-corrected unless this frame says FILED — an agreeable promise with no write behind",
  "it is the exact failure this channel exists to end.",
].join(" ");

const CORRECTION_COMPREHENSION_SYSTEM = [
  "You are the booth's corrections gate (§5.4, player authority): the player has",
  "been talking with the studio, and their latest words MAY be telling you the",
  "RECORD is wrong — a hard line written inverted, a fact stored backwards, a",
  "catalog entry that has someone wrong. Your verdict decides whether the engine",
  "retires a line of that record and writes another in its place.",
  "player_states_record_is_wrong is true ONLY when the PLAYER'S OWN WORDS say an",
  "established record is WRONG. Wanting the story to go differently from here on",
  "is DIRECTION, not a correction. Disliking a scene is not a correction. A new",
  "fact about the world ADDS; a correction RETIRES. The studio's own agreement",
  "that something is wrong is never grounds — it is the player's claim or nothing.",
  "target_kind: 'critical_fact' for the standing record (hard lines, the",
  "intensity contract, premise laws, facts held always-true); 'entity' for a",
  "person, faction, place, or thread whose dossier is wrong.",
  "target_hint: the wrong record's OWN words, quoted as closely as you can",
  "(critical_fact), or the exact catalog name (entity). The engine binds by this",
  "text; a vague hint matches nothing and files nothing — which is the RIGHT",
  "outcome when you cannot tell which line is wrong.",
  "record_text: the corrected record restated in ONE line, in the RECORD's own",
  "register — a hard line stays 'HARD LINE (absolute): ...'. Never an echo of the",
  "chat, never a promise, never a sentence about the player.",
  "When in doubt, false. A wrongly filed correction destroys a line of the record",
  "the player never asked you to touch; a bounced one costs a sentence saying so,",
  "and the player can state it again plainly.",
].join(" ");

/**
 * §7.4-shaped comprehension-before-compliance for the record (M3R2 C4), the
 * sibling of comprehendOverride: the router's probe signal alone must never
 * be enough to retire a line of the record, so the judged instrument decides.
 */
export async function comprehendCorrection(
  selection: TierSelection,
  campaignId: string,
  turnNumber: number,
  playerWords: string,
  context: string,
): Promise<CorrectionComprehension> {
  return callJudgment(selection, {
    name: "correction_comprehension",
    phase: "booth",
    schema: CorrectionComprehension,
    campaignId,
    turnNumber,
    effort: "high",
    maxTokens: CLASSIFY,
    system: CORRECTION_COMPREHENSION_SYSTEM,
    prompt: [context ? `BOOTH SO FAR:\n${context}` : "", `THE PLAYER'S WORDS:\n${playerWords}`]
      .filter(Boolean)
      .join("\n\n"),
  });
}

/** Shorter than this is a fragment, not a quotable statement — it would match anything. */
const CORRECTION_QUOTE_MIN = 8;
const normalizeQuote = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The words gate (M3R2 C4, "gated on the player's words, never the responder's
 * inference"): a correction extracted at close time must quote something the
 * PLAYER actually said in this booth. The responder agreeing that the record
 * looks wrong is the studio correcting the record about itself — which is the
 * one authority §5.4 never grants it.
 */
export function groundedInPlayerWords(exchanges: BoothExchange[], quote: string): boolean {
  const needle = normalizeQuote(quote);
  if (needle.length < CORRECTION_QUOTE_MIN) return false;
  const spoken = exchanges
    .filter((e) => e.role === "player")
    .map((e) => normalizeQuote(e.text))
    .join("\n");
  return spoken.includes(needle);
}

/** What the responder is told, and what the warn log records — filed or not. */
export interface CorrectionFiling {
  filed: boolean;
  note: string;
  /**
   * The ledger key to record when this filing actually WROTE. Absent when
   * nothing was written AND when the write was skipped as already-filed —
   * either way the ledger must not grow a second copy of the same key.
   */
  key?: string;
}

/** djb2 over the normalized replacement — cheap, and a ≤3-entry-per-booth ledger. */
function cheapHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * The filed-corrections idempotency key (types/booth.ts BoothState). Normalized
 * the way each half of the correction is MATCHED: the hint through the identity
 * key (the entity path's own equality, and case/punctuation tolerance for a
 * quoted record line), the replacement through a cheap hash of its normalized
 * text — the same correction restated by two different extractors keys the
 * same, and two different corrections on one target do not.
 */
export function correctionKey(
  targetKind: CorrectionTargetKind,
  targetHint: string,
  correctedContent: string,
): string {
  return `${targetKind}:${identityKey(targetHint) ?? ""}:${cheapHash(normalizeQuote(correctedContent))}`;
}

/**
 * The skip outcome: this correction already landed, so the write is not
 * repeated. It still names what was filed — the responder is answering a player
 * who just restated it, and "already done" with nothing to point at is the same
 * unverifiable noise the channel exists to end.
 */
const alreadyFiled = (recordText: string): CorrectionFiling => ({
  filed: true,
  note: `FILED (already) — this exact correction landed earlier in this conversation and was not written a second time; what landed reads: "${recordText}"`,
});

/**
 * Gate, then file (M3R2 C4). The judged verdict decides; the record's own
 * machinery (M2-C3's retire-and-replace, via applyRecordCorrection) writes.
 * Every failure mode — a bounced verdict, an unresolvable target, a gate that
 * threw — returns a note saying so rather than a guess: nothing is written on
 * a maybe, and the booth's reply carries the reason out loud.
 *
 * The write lands with provenance "player_correction", confidence 1, at the
 * CURRENT turn — so it is revocable exactly like every other layer write: a
 * rewind past this turn tombstones the replacement and restores what it
 * retired (rewind.ts step 1a).
 *
 * The `ledger` is what keeps a correction from being filed TWICE (the audit's
 * entity double-filing): the critical_fact path self-cancels on a re-run
 * (its target is tombstoned), the entity path does NOT — a revision leaves the
 * row live and identity-resolvable, so the close-time net and crash-replay
 * both re-revised a dossier the booth had already corrected. A proposal that
 * carries the target up front (the close-time net) is checked BEFORE the gate
 * and costs no model call at all; the verdict's own key is checked again
 * before the write, which is the rung the mid-exchange path can reach (there
 * the hint IS the gate's output).
 */
async function fileCorrection(
  db: Db,
  selection: TierSelection,
  args: {
    campaignId: string;
    turnNumber: number;
    playerWords: string;
    context: string;
    /** Keys of the corrections this booth has already filed (BoothState). */
    ledger: string[];
    /** The close-time extractor's proposal; used only where the gate left a field empty. */
    proposed?: { targetKind: CorrectionTargetKind; targetHint: string; correctedContent: string };
  },
): Promise<CorrectionFiling> {
  if (
    args.proposed &&
    args.ledger.includes(
      correctionKey(
        args.proposed.targetKind,
        args.proposed.targetHint,
        args.proposed.correctedContent,
      ),
    )
  ) {
    return alreadyFiled(args.proposed.correctedContent);
  }

  let verdict: CorrectionComprehension;
  try {
    verdict = await comprehendCorrection(
      selection,
      args.campaignId,
      args.turnNumber,
      args.playerWords,
      args.context,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[booth] correction gate failed — filing nothing: ${detail}`, {
      campaignId: args.campaignId,
      turnNumber: args.turnNumber,
    });
    return {
      filed: false,
      note: "HEARD, NOT FILED — the studio could not read the correction cleanly; nothing in the record changed.",
    };
  }

  if (!verdict.player_states_record_is_wrong) {
    return {
      filed: false,
      note: "HEARD, NOT FILED — this reads as direction or discussion rather than the player saying the record itself is wrong; nothing in the record changed.",
    };
  }

  const targetKind = verdict.target_hint.trim()
    ? verdict.target_kind
    : (args.proposed?.targetKind ?? verdict.target_kind);
  const targetHint = verdict.target_hint.trim() || (args.proposed?.targetHint ?? "");
  const correctedContent = verdict.record_text.trim() || (args.proposed?.correctedContent ?? "");

  const key = correctionKey(targetKind, targetHint, correctedContent);
  if (args.ledger.includes(key)) return alreadyFiled(correctedContent);

  // The write itself must never take the booth down with it (audit finding):
  // a pool timeout or a constraint on the correction's write is a record that
  // did not change, which is a SENTENCE — not a dead exchange whose player
  // message never even reached booth_state.
  let outcome: CorrectionOutcome;
  try {
    outcome = await applyRecordCorrection(db, selection, {
      campaignId: args.campaignId,
      turnNumber: args.turnNumber,
      targetKind,
      targetHint,
      correctedContent,
      provenance: PLAYER_CORRECTION_PROVENANCE,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[booth] correction write failed — filing nothing: ${detail}`, {
      campaignId: args.campaignId,
      turnNumber: args.turnNumber,
    });
    return {
      filed: false,
      note: `HEARD, NOT FILED — the record write failed (${detail}); nothing in the record changed.`,
    };
  }

  if (!outcome.filed) {
    return {
      filed: false,
      note: `HEARD, NOT FILED — ${outcome.reason}. Nothing in the record changed; ask the player to quote the line as it stands so it can be found.`,
    };
  }
  return { filed: true, note: `FILED — the record now reads: "${outcome.recordText}"`, key };
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
    phase: "booth",
    schema: BoothRoute,
    campaignId,
    turnNumber,
    system: BOOTH_ROUTER_SYSTEM,
    prompt: routerPrompt,
    maxTokens: CLASSIFY,
  }).catch((err) => {
    console.warn(
      `[booth] router failed — defaulting to director: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      responder: "director" as const,
      reason: "router failure default",
      record_correction_signal: false,
    };
  });
  const responder = route.responder;

  // (2b) THE CORRECTIONS CHANNEL (M3R2 C4) — the §7.4 ladder, one rung at a
  // time: the router already classified, so a signalled message (and only a
  // signalled message) pays for the judged gate that can actually move the
  // record. The write happens BEFORE the responder speaks so its
  // acknowledgement can name a change that has already landed — the
  // 2026-08-03 incident was exactly a promise the engine had no way to keep.
  //
  // Crash-replay safe by LEDGER, not by luck: the critical_fact path
  // self-cancels (the retired text is no longer live), but an entity revision
  // leaves its row live and resolvable by the same name — a replay revised the
  // dossier twice. The key is recorded the moment the write lands, and
  // persisted before the responder speaks, so a filing whose exchange never
  // reached booth_state (a refused reply, a crash mid-stream) still cannot
  // repeat.
  let correctionNote: string | undefined;
  let ledger = state.filed_corrections;
  if (route.record_correction_signal) {
    const filing = await fileCorrection(db, selection, {
      campaignId,
      turnNumber,
      playerWords: playerInput,
      context: formatTranscript(recent),
      ledger,
    });
    correctionNote = filing.note;
    if (filing.key) {
      ledger = [...ledger, filing.key];
      await db
        .update(campaigns)
        .set({ boothState: { ...state, filed_corrections: ledger }, updatedAt: new Date() })
        .where(eq(campaigns.id, campaignId));
    }
    if (!filing.filed) {
      console.warn(`[booth] correction not filed — ${filing.note}`, { campaignId, turnNumber });
    }
  }

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
  if (correctionNote) {
    parts.push(`## Record changes on this message\n${correctionNote}`);
  }
  parts.push(
    "Reply out-of-fiction: no scene prose, no narration — the concise, candid voice of the studio room. When the matter is genuinely settled, say so naturally.",
  );
  parts.push(BOOTH_CORRECTION_DISCIPLINE);
  if (atCap) {
    parts.push("This is the final exchange — emit a resolution summary of what was decided.");
  }
  const userMessage = parts.join("\n\n");

  const { stream, done } = streamNarration({
    name: "booth_responder",
    phase: "booth",
    selection,
    system: blocks?.system ?? [],
    // The booth reads the same conversation the pen writes in (M3R2 C2):
    // recent play threads ahead of the booth frame as real turns, so the
    // responder discusses scenes it can actually see.
    messages: [...(blocks?.exchangeMessages ?? []), { role: "user", content: userMessage }],
    maxTokens: PROSE_COMPOSER,
    // The composer tool-law (M3 C1, restated by the C2 review): tools render
    // AHEAD of system in the cache key, so `tools: []` guaranteed a miss on
    // the KA's cached prefix however identical the blocks were. The KA's
    // array under tool_choice `none` makes the prefix bytes match while the
    // booth stays structurally unable to call a tool — §5.4's reuse mandate,
    // actually satisfied.
    tools: KA_TOOLS,
    toolChoice: { type: "none" },
    campaignId,
    turnNumber,
  });
  stream.on("text", (t) => emit(t));
  const result = await done();
  // A clipped reply is still returned (the booth must not stall), but the clip
  // is honest, not silent (M2R2 §6).
  if (result.message.stop_reason === "max_tokens") {
    console.warn("[booth] responder truncated at max_tokens — returning clipped reply", {
      campaignId,
      turnNumber,
    });
  }
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
    filed_corrections: ledger,
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
 * #4, provenance meta_booth, confidence 0.9), override rows, and any record
 * CORRECTIONS the player's own words settled (M3R2 C4, each gated and filed
 * through M2-C3's retire-and-replace) → clear booth_state. Called at cap by
 * runBoothExchange, and by the runtime when a
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
  // Already-known taste rides the extraction prompt (R4 audit): a blind
  // extractor re-notes the same durable taste every booth, and near-dupes
  // evict distinct notes from the slice(-3) windows Settei/recap read.
  const [playerRow] = await db
    .select({ profile: players.profile })
    .from(players)
    .where(eq(players.id, campaign.playerId));
  const knownTaste = (playerRow?.profile as { taste?: string[] } | null)?.taste ?? [];
  let resolution: BoothResolution | null = null;
  try {
    resolution = await callJudgment(selection, {
      name: "booth_resolution",
      phase: "booth",
      schema: BoothResolution,
      campaignId,
      turnNumber,
      effort: "medium",
      maxTokens: STRUCTURED_RICH,
      system: BOOTH_RESOLUTION_SYSTEM,
      prompt: [
        knownTaste.length > 0
          ? `Already-known player taste (only set player_taste_note for something NEW):\n${knownTaste
              .slice(-6)
              .map((t) => `- ${t}`)
              .join("\n")}\n`
          : "",
        `Booth transcript:\n${formatTranscript(state.exchanges)}`,
      ]
        .filter(Boolean)
        .join("\n"),
    });
  } catch (err) {
    console.warn(
      `[booth] resolution extraction failed — clearing without calibration: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (resolution) {
    // The ceilings the schema can no longer carry (types/booth.ts): surplus
    // entries drop with a warn, the resolution itself always lands.
    const marks = capBooth(resolution.marks, BOOTH_MARKS_MAX, "marks", campaignId);
    const overrideRules = capBooth(
      resolution.overrides,
      BOOTH_OVERRIDES_MAX,
      "overrides",
      campaignId,
    );
    const tasteNote = resolution.player_taste_note?.trim();
    if (marks.length > 0) {
      await db.insert(pencilMarks).values(
        marks.map((m) => ({
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
    if (overrideRules.length > 0) {
      await db.insert(overrides).values(
        overrideRules.map((content) => ({
          campaignId,
          content,
          active: true,
          turnId: turnNumber,
          provenance: BOOTH_PROVENANCE,
          confidence: 1,
        })),
      );
    }
    // §5.4 corrections (M3R2 C4): the close-time net. Most corrections file
    // during the exchange that made them (the responder needs the outcome to
    // answer honestly), but one settled ACROSS exchanges — "that's backwards"
    // now, the right version three messages later — is only visible from the
    // whole transcript. A correction this booth ALREADY filed is skipped on
    // its ledger key before the gate runs: self-cancellation covers only the
    // critical_fact path (its target is tombstoned), and the close-time net
    // re-revised the entity dossiers the exchange path had already corrected.
    // Each key persists as it lands, so a crash between two close-time
    // corrections cannot re-file the first. There is no reply left to carry a
    // failure, so an unfiled one surfaces in the warn log rather than nowhere.
    const corrections = capBooth(
      resolution.corrections ?? [],
      BOOTH_CORRECTIONS_MAX,
      "corrections",
      campaignId,
    );
    let ledger = state.filed_corrections;
    for (const correction of corrections) {
      if (!groundedInPlayerWords(state.exchanges, correction.player_words)) {
        console.warn("[booth] correction dropped — not grounded in the player's own words", {
          campaignId,
          turnNumber,
          quoted: correction.player_words.slice(0, 120),
        });
        continue;
      }
      const filing = await fileCorrection(db, selection, {
        campaignId,
        turnNumber,
        playerWords: correction.player_words,
        context: formatTranscript(state.exchanges),
        ledger,
        proposed: {
          targetKind: correction.target_kind,
          targetHint: correction.target_hint,
          correctedContent: correction.corrected_content,
        },
      });
      if (filing.key) {
        ledger = [...ledger, filing.key];
        await db
          .update(campaigns)
          .set({ boothState: { ...state, filed_corrections: ledger }, updatedAt: new Date() })
          .where(eq(campaigns.id, campaignId));
      }
      if (!filing.filed) {
        console.warn(`[booth] close-time correction not filed — ${filing.note}`, {
          campaignId,
          turnNumber,
        });
      }
    }

    // §6.9 layer-10 writer #2 (M2R R4): a booth-revealed PLAYER taste note
    // appends to the cross-campaign profile (same append-only shape as SZ).
    // Over-budget → dropped with a warn, exactly as at session close: an
    // optional decoration never costs the resolution it rides on.
    if (tasteNote && tasteNote.length > TASTE_NOTE_MAX) {
      console.warn("[booth] taste note over budget — dropped, resolution kept", {
        campaignId,
        length: tasteNote.length,
        limit: TASTE_NOTE_MAX,
      });
    } else if (tasteNote) {
      // Atomic append (R4 audit): three writers share the player row; the
      // helper also trims (a padded note landed verbatim before).
      await appendPlayerTaste(db, campaign.playerId, [tasteNote]);
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

const OVERRIDE_COMPREHENSION_SYSTEM = [
  "You are the override channel's comprehension step (§7.4): the input was",
  "classified as a standing-rule demand, and your verdict decides whether",
  "the studio binds itself. contains_standing_rule is true ONLY when the",
  "words are aimed at the STUDIO ITSELF, laying down a rule for how the",
  "story is run from here on, across scenes. An imperative aimed into the",
  "fiction — commanding the character, directing the scene, speaking or",
  "acting as them, however forceful — is NOT a rule: false. A one-beat",
  "request (this scene only) is scope one_shot: direction, not law. rule:",
  "restate the player's rule in ONE short imperative sentence, in the",
  "studio's own words — never an echo of their text; empty string when",
  "contains_standing_rule is false. When in doubt, false — a wrongly minted",
  "rule corrupts every future scene; a bounced one costs a single beat and",
  "the player can lay it down again in so many words.",
].join(" ");

/**
 * §7.4 comprehension-before-compliance (M3R1): one judged look before the
 * override ledger's write. The probe's OVERRIDE_COMMAND classification alone
 * is never enough to eat a scene — the mint fires only when this second,
 * stronger instrument agrees there is a standing rule; anything else bounces
 * back to the story pipeline. Compliance stays immediate and unnegotiated
 * for real rules: the acknowledgement quotes the RESTATEMENT, which is the
 * mutual-understanding surface — a wrong reading is visible the moment it
 * lands, and the correction is just the next player input.
 */
export async function comprehendOverride(
  selection: TierSelection,
  campaignId: string,
  turnNumber: number,
  text: string,
): Promise<OverrideComprehension> {
  return callJudgment(selection, {
    name: "override_comprehension",
    phase: "turn",
    schema: OverrideComprehension,
    campaignId,
    turnNumber,
    effort: "high",
    maxTokens: CLASSIFY,
    system: OVERRIDE_COMPREHENSION_SYSTEM,
    prompt: `PLAYER INPUT: ${text}`,
  });
}
