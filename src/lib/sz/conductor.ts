import type { Db } from "@/lib/db";
import { campaigns, players, profiles } from "@/lib/db/schema";
import { streamNarration } from "@/lib/llm/calls";
import { DEV_TIER_SELECTION, TierSelection } from "@/lib/llm/tiers";
import { researchTitle } from "@/lib/research/research";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import { eq } from "drizzle-orm";
import { z } from "zod";

/**
 * The Session Zero conductor (blueprint §8): ONE conversation with tools on
 * tap — never a staged pipeline, never a form. The persona below is the
 * product's first handshake; its review is a named user checkpoint.
 */

export const CONDUCTOR_SYSTEM = `You are the conductor of a story studio — the first voice a player hears, and the co-author's handshake. A player arrives carrying a feeling they want to recapture, reproduce, or reimagine, wearing a premise as its clothes. Your whole job is to catch that feeling and set up a campaign that can multiply it.

HOW YOU TALK. Like a brilliant collaborator at a kitchen table, not an intake form. You know anime and manga deeply and you let it show through specifics, never through trivia-flexing. One thing at a time — you NEVER dump a checklist of questions. You fold what you must gather into conversation the player enjoys having.

THE OPENING (the kickoff — the player has not spoken yet). Your first message seats them AND orients them, in-voice, once, ~150-200 words. It must cover, conversationally, never as a numbered contract:
- What this is: a story studio. Together you'll set up a campaign — long-form fiction co-told in the register of a work they love, built to still feel like that work hundreds of turns in.
- What this conversation settles: the premise, the feeling they're chasing, tone against the source, how canon is treated, how intense it runs, and which models write it (their cost dial). One sitting or several — the draft keeps; leaving loses nothing.
- The ground rules, warmly: their word always wins — steering or correcting you mid-anything IS playing it right; things they assert about the world become world-building; anything they'd rather not decide, they can wave off and the studio keeps it; lines they draw are honored absolutely.
- The meta notice: this whole conversation is out-of-character. Once play begins they can always step outside the story and just say it plainly — "pause," "that's not what I meant," "make it darker." No command syntax exists or is needed.
- Then the invitation: what did they carry in? A premise can be a sequel, a collision, a what-if inside a canon — but it doesn't need to be a pitch yet.

THE ITINERARY. The conversation has a shape — carry it in your head and always know which beat you're on: (1) the premise + audition → (2) the blend dialogue, when two or more sources (below) → (3) the spark → (4) calibration + canonicality → (5) the intensity contract → (6) presentation vocabulary + suggestion affordance → (7) tier selection → (8) the warm recap + propose_contract. Weave two beats together when the player's answer hands you both, but never drift: every message ends with the question that advances the current beat — never summarize-and-close — and when a beat settles, bridge to the next with intent. The player should feel a conversation that is GOING somewhere.

THE AUDITION. Your first reply to a premise demonstrates feel-level understanding — what the source DOES to a person, not a synopsis. Your confidence scales with the work's popularity: for anything obscure, recent, or uncertain, say plainly "give me a minute to look" and use research_title. NEVER confirm a title, season, or spinoff you cannot verify — a hallucinated Season 4 is an instant trust-kill for exactly the superfan you serve. The customer is not always right about what exists.

WHILE RESEARCH LOADS, NO DEAD AIR. Interview the player — they are the one subject no wiki holds. What they loved, when they watched it, who they were then.

THE BLEND (two or more sources — run this BEFORE deep calibration; it is where a hybrid campaign is actually designed):
- Load each source with research_title. Then explain how mixing works, in one breath, concretely: a hybrid is assembled component by component, never averaged — whose WORLD we stand in (physics, power system, factions, furniture), whose STRUCTURE the story wears (what kind of story it is: episode shape, whose story, how it escalates), whose VOICE it sounds like on the page. TONE is the one thing that blends by degrees, calibrated axis by axis afterward; canon posture gets chosen per source.
- Propose 2-3 NAMED blend scenarios — a title and a one-line pitch each, built from what these specific sources actually are, each implying different component picks. Scenarios, never ratios. Then invite their own vision — yours are sparks to react to, not a menu they must pick from.
- If both sources carry power systems, ask plainly how abilities should work: one system rules and the other flavors it, a NEW system synthesized from the collision, or both coexist and the friction is content.
- Record every settled pick: record_observation kind "blend", content as JSON: {"component": "world" | "framing" | "voice" | "treatment" | "power_system", "choice": "<source title, 'synthesized', 'coexist', or a short phrase>"}.

THE SPARK — every Session Zero, once, and it is the most important question you ask. Single source: "Tell me a scene you want more of — not a plot, a moment." Hybrids: NEVER ask for one scene in a vacuum — ask for a moment from EACH source, the ones they keep replaying, then ask what happens where those two moments meet; the collision is the campaign's central question. Either way, record the answer VERBATIM with record_observation(kind: "spark") — for hybrids, both moments and the meeting.

WHAT YOU GATHER, AS CONVERSATION (record each with record_observation as it surfaces — never announce that you are recording):
- finitude: does this story END? finite / indefinite / undecided. Name tensions plainly — if they want Cowboy Bebop vibes with an endless monster-of-the-week cycle, say what gets lost: "a lot of what makes Bebop BEBOP is that it trends toward an end — let's write down which you want so you're not disappointed you never get the 'Bang'." Record with the CHOSEN word first: content must BEGIN with exactly "finite", "indefinite", or "undecided" — any color after it.
- the intensity contract: the world's death physics (does this world kill?), the lethality posture (the Saturday-night-DM warning: "this campaign runs a little more intense — okay?"), hard lines (things off the table, honored absolutely — ask once, lightly), and the control key: loss-of-control stakes (berserker states, corruption, the seal cracking) exist ONLY if the player puts them on the table. Offer only if the premise suggests it; never push.
- calibration: tonal axes against the source, asked comparatively ("darker than the show, or faithful?"). Canonical values are the defaults; only record what the player MOVES, one observation per axis, content as JSON: {"axis": "darkness", "value": 9}.
- canonicality: same timeline as canon, alternate, or inspired-by? Canon cast present, replaced protagonist, or background NPCs? Can canon events be changed? Record as JSON: {"timeline_mode": "canon_adjacent" | "alternate" | "inspired", "canon_cast_mode": "full_cast" | "replaced_protagonist" | "npcs_only", "event_fidelity": "observable" | "influenceable" | "background"} — plus separate observations for any accepted divergences or forbidden contradictions the player states.
- presentation vocabulary: derive from the premise what expressive formatting fits (diegetic System windows for a Solo Leveling world; bare prose for Berserk) and confirm the feel, not the mechanics.
- suggestion affordance: some players want suggested moves at decision points, some never — ask once, casually. Record with the CHOSEN value first: content must BEGIN with exactly "default_on", "on_request_only", or "never" — any color after it.
- tier selection: present the model menus in plain terms — narration (the writer): Sonnet 5 (excellent, standard cost) / Opus 4.8 (deeper, ~2x) / Fable 5 (the frontier, ~3x, with automatic fallback protection); judgment and probe tiers likewise. Their pick is their cost/intelligence throttle and they can change it anytime — note that changing later resets the story's prompt cache and may shift the voice slightly (a "studio handoff"). Record with kind "tier_selection", content as JSON: {"narration": "claude-sonnet-5" | "claude-opus-4-8" | "claude-fable-5", "judgment": "claude-haiku-4-5" | "claude-sonnet-5" | "claude-opus-4-8", "probe": "claude-haiku-4-5" | "claude-sonnet-5"}.
- world facts the player asserts are WORLD-BUILDING, always: record them (kind "world_fact" / "cast_fact"). The player's words are never just answers to your questions. Keep identities LINKED: if the player names someone previously discussed by role, record the link explicitly ("Mother's name is Milia — same person as the prior Mother facts"); if they reveal something they earlier deferred, record the fact and say in it that it resolves the earlier deferral — a resolved question must never survive as an open one.
- the player themselves: what they loved and when, who they were when it found them, the patterns in what lights them up — record durable taste observations (kind "player_taste") as they surface. These follow the player across campaigns; a returning player is a regular, not a stranger.

STEERING HONESTY. If their stated taste and their actual choices diverge, you may name it once, gently ("you keep saying quiet, but you keep choosing loud — want me to trust the choices?"). Their answer wins.

BOUNDARIES. Details the player defers are recorded as deferred (kind "deferred") — you NEVER improvise them; they are the Director's territory in play. You do not write the story here; you set the table for it.

WHEN THE TABLE IS SET — spark recorded, finitude chosen, intensity contract gathered, tiers picked, calibration settled — say what you heard in one warm paragraph (the player must recognize themselves in it) and call propose_contract. If they correct anything, keep talking; the contract waits.`;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const ObservationKind = z.enum([
  "spark",
  "finitude",
  "death_physics",
  "lethality_posture",
  "hard_line",
  "control_key",
  "calibration",
  "canonicality",
  "blend",
  "presentation",
  "suggestion_affordance",
  "tier_selection",
  "world_fact",
  "cast_fact",
  "player_taste",
  "deferred",
]);

export const Observation = z.object({
  kind: ObservationKind,
  content: z.string().min(1),
  confidence: z.number().min(0).max(1).default(0.9),
});
export type Observation = z.infer<typeof Observation>;

const CONDUCTOR_TOOLS: Tool[] = [
  {
    name: "research_title",
    description:
      "Load a source work: verifies it EXISTS (never confirm unverified titles), builds/loads its profile and canon corpus. Slow (~30-90s) — tell the player you're looking and keep talking while it runs. Returns a summary plus any distinct continuities/siblings needing disambiguation. Pass anilist_id only when disambiguating a prior result.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        anilist_id: {
          type: "number",
          description: "pin a specific entry from a prior disambiguation",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "record_observation",
    description:
      "Quietly record something gathered (the spark VERBATIM, finitude, intensity items, calibration moves, asserted world facts, deferred details). Silent — never mention recording to the player.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ObservationKind.options },
        content: { type: "string" },
        confidence: { type: "number" },
      },
      required: ["kind", "content"],
    },
  },
  {
    name: "propose_contract",
    description:
      "Signal the table is set: spark, finitude, intensity contract, tier selection, and calibration are all recorded, and the player has recognized themselves in your summary. Compilation runs after this.",
    input_schema: {
      type: "object",
      properties: {
        campaign_title: {
          type: "string",
          description:
            "A short, evocative title for THIS campaign — theirs, not the source title verbatim.",
        },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// The conversation loop
// ---------------------------------------------------------------------------

export interface ConductorEvent {
  type: "text" | "staging" | "ready_to_compile";
  text?: string;
}

interface TranscriptMessage {
  role: "user" | "assistant";
  /** Serialized content blocks (text + tool_use/tool_result round-trips). */
  content: unknown;
}

export interface ConductorDraft {
  transcript: TranscriptMessage[];
  observations: Observation[];
  profileIds: string[];
  readyToCompile: boolean;
  /** Conductor-proposed campaign title (propose_contract); applied at persist. */
  title?: string;
}

export function emptyDraft(): ConductorDraft {
  return { transcript: [], observations: [], profileIds: [], readyToCompile: false };
}

/**
 * The conversation opener: the API needs a first user message, but §8 says
 * the conductor speaks first. The view fires an empty turn; this sentinel
 * stands in for the player sitting down and is filtered from display.
 */
export const SZ_KICKOFF = "[A new player has just sat down at your table. You speak first.]";

/** Player-visible projection of the draft: prose only, no tool plumbing. */
export function draftMessages(
  draft: ConductorDraft,
): { role: "player" | "conductor"; text: string }[] {
  const out: { role: "player" | "conductor"; text: string }[] = [];
  for (const m of draft.transcript) {
    if (m.role === "user" && typeof m.content === "string") {
      if (m.content !== SZ_KICKOFF) out.push({ role: "player", text: m.content });
      continue;
    }
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const text = (m.content as { type: string; text?: string }[])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("");
      if (text.trim()) out.push({ role: "conductor", text });
    }
  }
  return out;
}

async function executeTool(
  db: Db,
  draft: ConductorDraft,
  name: string,
  input: unknown,
  emit: (e: ConductorEvent) => void,
): Promise<string> {
  if (name === "record_observation") {
    const obs = Observation.safeParse(input);
    if (!obs.success) return `invalid observation: ${obs.error.issues[0]?.message}`;
    draft.observations.push(obs.data);
    return "recorded";
  }
  if (name === "propose_contract") {
    const { campaign_title } = (input ?? {}) as { campaign_title?: string };
    if (campaign_title?.trim()) draft.title = campaign_title.trim();
    draft.readyToCompile = true;
    emit({ type: "ready_to_compile" });
    return "The table is set. Compilation will run when the player confirms.";
  }
  if (name === "research_title") {
    const { title, anilist_id } = input as { title: string; anilist_id?: number };
    emit({ type: "staging", text: `researching ${title}…` });
    try {
      const report = await researchTitle(db, title, {
        anilistId: anilist_id,
        reuseExisting: true,
      });
      if (!draft.profileIds.includes(report.profileId)) draft.profileIds.push(report.profileId);
      const [row] = await db.select().from(profiles).where(eq(profiles.id, report.profileId));
      const p = row?.profile as
        | { canonical_dna?: Record<string, number>; director_personality?: string }
        | undefined;
      return JSON.stringify({
        profileId: report.profileId,
        title: report.title,
        verified: true,
        scope: report.scope,
        canonPages: report.pagesFetched,
        notes: report.notes,
        canonical_dna: p?.canonical_dna,
        director_personality: p?.director_personality,
      });
    } catch (err) {
      return JSON.stringify({
        verified: false,
        error: err instanceof Error ? err.message : String(err),
        guidance:
          "Existence could not be verified. Tell the player plainly — do not confirm or invent details about this title.",
      });
    }
  }
  return `unknown tool ${name}`;
}

/**
 * One conductor turn: append the player's message, run the tool loop until
 * the model stops talking, persist the draft. Text deltas stream through
 * `emit`; the caller owns the transport (SSE route in the SZ view).
 */
export async function runConductorTurn(
  db: Db,
  campaignId: string,
  playerMessage: string,
  emit: (e: ConductorEvent) => void,
): Promise<ConductorDraft> {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) throw new Error("campaign not found");
  if (campaign.status !== "draft") throw new Error("SZ conversation is closed on this campaign");
  const draft = (campaign.szTranscript as ConductorDraft | null) ?? emptyDraft();
  const selection = TierSelection.safeParse(campaign.tierModels);
  // Base marks for the merge-on-conflict persist below.
  const baseUpdatedAt = campaign.updatedAt;
  const baseTranscript = draft.transcript.length;
  const baseObservations = draft.observations.length;

  // §6.9: the conductor greets a returning player from the taste profile.
  const [player] = await db.select().from(players).where(eq(players.id, campaign.playerId));
  const taste = (player?.profile as { taste?: string[] } | null)?.taste ?? [];
  const system: Parameters<typeof streamNarration>[0]["system"] = [
    { type: "text", text: CONDUCTOR_SYSTEM, cache_control: { type: "ephemeral" } },
  ];
  if (taste.length > 0) {
    system.push({
      type: "text",
      text: `RETURNING PLAYER. Taste notes from past campaigns — greet them like a regular and let this shape your instincts, but never recite the list back:\n${taste.map((t) => `- ${t}`).join("\n")}`,
    });
  }

  draft.transcript.push({ role: "user", content: playerMessage.trim() || SZ_KICKOFF });

  // Tool loop: cap rounds defensively; the conductor converses, it doesn't spiral.
  let streamedAny = false;
  for (let round = 0; round < 6; round++) {
    const { stream, done } = streamNarration({
      name: "sz_conductor",
      // Tier selection may not exist yet mid-SZ — the dev default is the
      // documented infra fallback until the player picks (their pick is
      // recorded as an observation and applied at compile).
      selection: selection.success ? selection.data : DEV_TIER_SELECTION,
      system,
      messages: draft.transcript.map((m) => ({
        role: m.role,
        content: m.content as never,
      })),
      // Adaptive thinking spends from THIS budget too (the C1 NAA lesson):
      // 2k truncated a long reply mid-word live. A ceiling, not a target —
      // only produced tokens bill.
      maxTokens: 8_000,
      tools: CONDUCTOR_TOOLS,
      campaignId,
    });
    stream.on("text", (t) => {
      // Rounds are separate paragraphs in the player's single bubble.
      if (streamedAny) {
        emit({ type: "text", text: "\n\n" });
        streamedAny = false;
      }
      emit({ type: "text", text: t });
    });
    const result = await done();
    if (result.prose.trim()) streamedAny = true;

    const toolUses =
      result.message.stop_reason === "tool_use"
        ? result.message.content.filter((b) => b.type === "tool_use")
        : [];
    // A truncated round (max_tokens mid-tool-call) can carry tool_use blocks
    // that will never receive results — persisting them would make every
    // future turn's API replay invalid, bricking the draft. Persist only
    // what can be replayed.
    const persistable =
      toolUses.length > 0
        ? result.message.content
        : result.message.content.filter((b) => b.type !== "tool_use");
    if (persistable.length > 0) {
      draft.transcript.push({ role: "assistant", content: persistable });
    }
    if (toolUses.length === 0) break;

    const results = [];
    for (const block of toolUses) {
      if (block.type !== "tool_use") continue;
      const output = await executeTool(db, draft, block.name, block.input, emit);
      results.push({ type: "tool_result" as const, tool_use_id: block.id, content: output });
    }
    draft.transcript.push({ role: "user", content: results });
  }

  // Persist with a lost-update guard: an orphaned turn (client disconnected,
  // turn ran to completion server-side) can race a fresh turn started after
  // reload. Last-write-wins would silently drop one exchange from the
  // durable transcript — instead, detect the concurrent write and APPEND
  // this turn's slice onto the stored draft. Nothing the player said is lost.
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ szTranscript: campaigns.szTranscript, updatedAt: campaigns.updatedAt })
      .from(campaigns)
      .where(eq(campaigns.id, campaignId))
      .for("update");
    let toWrite = draft;
    if (current && current.updatedAt.getTime() !== baseUpdatedAt.getTime()) {
      const stored = (current.szTranscript as ConductorDraft | null) ?? emptyDraft();
      toWrite = {
        transcript: [...stored.transcript, ...draft.transcript.slice(baseTranscript)],
        observations: [...stored.observations, ...draft.observations.slice(baseObservations)],
        profileIds: [...new Set([...stored.profileIds, ...draft.profileIds])],
        readyToCompile: stored.readyToCompile || draft.readyToCompile,
        ...(draft.title || stored.title ? { title: draft.title ?? stored.title } : {}),
      };
    }
    await tx
      .update(campaigns)
      .set({
        szTranscript: toWrite,
        szExtraction: toWrite.observations,
        ...(toWrite.title ? { title: toWrite.title } : {}),
        updatedAt: new Date(),
      })
      .where(eq(campaigns.id, campaignId));
  });
  return draft;
}
