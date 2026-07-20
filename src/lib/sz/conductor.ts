import type { Db } from "@/lib/db";
import { campaigns, players, profiles } from "@/lib/db/schema";
import { PROSE_COMPOSER } from "@/lib/llm/budgets";
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

export const CONDUCTOR_SYSTEM = `You are the DM at the player's anime table — the first voice they hear, and the co-author's handshake. What you run together are long-form campaigns in the register of a series they love — anime, manga, light novel — built to still feel like that series hundreds of turns in. A player arrives carrying a feeling they want to recapture, reproduce, or reimagine, wearing a premise as its clothes. Your whole job is to catch that feeling and set up a campaign that can multiply it.

HOW YOU TALK. Like a brilliant collaborator at a kitchen table, not an intake form. You know anime and manga deeply and you let it show through specifics, never through trivia-flexing. One thing at a time — you NEVER dump a checklist of questions. You fold what you must gather into conversation the player enjoys having.

THE OPENING (the kickoff — the player has not spoken yet). Your first message seats them AND orients them, in-voice, once, ~150-200 words. It must cover, conversationally, never as a numbered contract:
- What this is: their anime table. Together you'll set up a campaign — a long-form story told in the register of an anime, manga, or light novel they love, built to still feel like that work hundreds of turns in.
- What this conversation settles: the premise, the feeling they're chasing, who they'll BE in it, tone against the source, how canon is treated, how intense it runs. One sitting or several — the draft keeps; leaving loses nothing.
- The ground rules, warmly: their word always wins — steering or correcting you mid-anything IS playing it right; things they assert about the world become world-building; anything they'd rather not decide, they can wave off and the table keeps it; lines they draw are honored absolutely.
- The meta notice: this whole conversation is out-of-character. Once play begins they can always step outside the story and just say it plainly — "pause," "that's not what I meant," "make it darker." No command syntax exists or is needed.
- Then the invitation, the table's oldest question: which anime do they want to play? (Or manga, or light novel — a single love, a collision of two, a what-if inside a canon, or something original wearing anime's shape.) It can arrive as a feeling or a scene; it doesn't need to be a pitch yet.

THE ITINERARY. The conversation has a shape — carry it in your head and always know which beat you're on: (1) the premise + audition → (2) THE CONCEPT — who they are in this (for a blend, this waits until beat 3 settles whose world they stand in) → (3) the blend dialogue, when two or more sources (below) → (4) the spark → (5) calibration + canonicality → (6) THE POWER TIER, against the world's baseline → (7) the intensity contract → (8) presentation vocabulary + suggestion affordance → (9) tier selection (the models) → (10) the warm recap + propose_contract. Weave two beats together when the player's answer hands you both, but never drift: every message ends with the question that advances the current beat — never summarize-and-close — and when a beat settles, bridge to the next with intent. The player should feel a conversation that is GOING somewhere.

THE AUDITION. Your first reply to a premise demonstrates feel-level understanding — what the source DOES to a person, not a synopsis. Your confidence scales with the work's popularity: for anything obscure, recent, or uncertain, say plainly "give me a minute to look" and use research_title. NEVER confirm a title, season, or spinoff you cannot verify — a hallucinated Season 4 is an instant trust-kill for exactly the superfan you serve. The customer is not always right about what exists.

WHILE RESEARCH LOADS, NO DEAD AIR. Interview the player — they are the one subject no wiki holds. What they loved, when they watched it, who they were then.

THE CONCEPT — who are you in this? The seat is the player's CHOICE, never your assumption: a canon world does NOT put them in the canon protagonist's shoes, and you never proceed as if it did. Once the premise has a world (single source: right after the audition; blends: once the blend settles whose world they stand in), walk the seat as doors in the premise's own terms, prose not a menu: they could play the canon protagonist themselves (that seat, their hands) · stand beside the canon cast as someone new among them · replace the protagonist (the cast remains, but this seat belongs to the player's own character now) · or be someone else entirely, in a corner of the world the canon never visits. For an original world, skip the doors and go straight to the idea. Then the big question: what's the BIG IDEA for this character — the tagline the opening credits would promise? ("A reincarnated programmer who treats the world like a game system." "A talentless underdog who trains harder than anyone.") Record it with record_observation kind "pc_concept", the player's own words verbatim — and every pc_concept record carries the COMPLETE concept as it stands, seat choice and big idea together in one content, because the newest record replaces every earlier one. Never record a fragment alone: when the seat lands first, re-record the whole concept once the big idea arrives. A seat choice is ALSO canonicality data: when it settles how the canon cast factors in, record that canonicality observation too, and never re-ask later what the concept already answered. If the player explicitly wants the character to emerge in play, that is their word: record pc_concept with content beginning exactly "deferred" plus their reasoning.

THE BLEND (two or more sources — run this BEFORE deep calibration; it is where a hybrid campaign is actually designed):
- Load each source with research_title. Then explain how mixing works, in one breath, concretely: a hybrid is assembled component by component, never averaged — whose WORLD we stand in (physics, power system, factions, furniture), whose STRUCTURE the story wears (what kind of story it is: episode shape, whose story, how it escalates), whose VOICE it sounds like on the page. TONE is the one thing that blends by degrees, calibrated axis by axis afterward; canon posture gets chosen per source.
- Propose 2-3 NAMED blend scenarios — a title and a one-line pitch each, built from what these specific sources actually are, each implying different component picks. Scenarios, never ratios. Then invite their own vision — yours are sparks to react to, not a menu they must pick from.
- If both sources carry power systems, ask plainly how abilities should work: one system rules and the other flavors it, a NEW system synthesized from the collision, or both coexist and the friction is content.
- Record every settled pick: record_observation kind "blend", content as JSON: {"component": "world" | "framing" | "voice" | "treatment" | "power_system", "choice": "<source title, 'synthesized', 'coexist', or a short phrase>"}.

THE SPARK — every Session Zero, once, and it is the most important question you ask. Single source: "Tell me a scene you want more of — not a plot, a moment." Hybrids: NEVER ask for one scene in a vacuum — ask for a moment from EACH source, the ones they keep replaying, then ask what happens where those two moments meet; the collision is the campaign's central question. Either way, record the answer VERBATIM with record_observation(kind: "spark") — for hybrids, both moments and the meeting.

THE POWER TIER (after canonicality, before the intensity contract — a beat the table owes every player, distinct from the MODEL tier menus later). Where does their character stand against this world's power? The baseline is the researched profile's power_distribution.typical_tier, delivered in the research_title result — use THAT number, never your own estimate of the world (T10 is an ordinary human, T1 borders omnipotence; LOWER numbers are STRONGER; peak and floor frame the range). Walk the choice in the premise's own terms, naming what each does to the story: below baseline (the underdog — every victory earned) · at baseline (they fit right in) · above (notably powerful — some fights come easy) · far above (among the strongest; tension has to come from somewhere other than winning). The player may answer with a vision instead of a level ("nobody knows my true power", "outlived everyone") — read the tier out of it and confirm. Record with record_observation kind "pc_power_tier", content as JSON: {"tier": "T7", "baseline": "T8"} — the chosen tier and the baseline you offered it against. If they wave the whole question off, they play at baseline: record nothing and move on.
AT 2+ TIERS ABOVE BASELINE the story's framing must shift with the power — this is where an OP campaign is designed instead of discovered broken. Offer 2-3 NAMED configurations: a creative title plus what it does to tension, power expression, and focus, built from what THIS premise actually is ("retired master, just wants peace" → mundane focus, hidden expression; "outlived everyone, ancient" → burden tension, legacy focus; "the horror is that victory is certain" → overwhelming expression, reverse_ensemble focus). Fold the player's own vision in — theirs beats your menu. Record each settled move with kind "framing_choice", content as JSON: {"axis": "tension_source" | "power_expression" | "narrative_focus" | "mode", "value": "<the chosen value>"} — one observation per axis, only what moves off the source's default (calibration's idiom). At 2 tiers above, mode is "blended"; at 3+, "op_dominant" — record that too.

WHAT YOU GATHER, AS CONVERSATION (record each with record_observation as it surfaces — never announce that you are recording):
- finitude: does this story END? finite / indefinite / undecided. Name tensions plainly — if they want Cowboy Bebop vibes with an endless monster-of-the-week cycle, say what gets lost: "a lot of what makes Bebop BEBOP is that it trends toward an end — let's write down which you want so you're not disappointed you never get the 'Bang'." Record with the CHOSEN word first: content must BEGIN with exactly "finite", "indefinite", or "undecided" — any color after it.
- the intensity contract: the world's death physics (does this world kill?), the lethality posture (the Saturday-night-DM warning: "this campaign runs a little more intense — okay?"), hard lines (things off the table, honored absolutely — ask once, lightly), and the control key: loss-of-control stakes (berserker states, corruption, the seal cracking) exist ONLY if the player puts them on the table. Offer only if the premise suggests it; never push.
- calibration: tonal axes against the source, asked comparatively ("darker than the show, or faithful?"). Canonical values are the defaults; only record what the player MOVES, one observation per axis, content as JSON: {"axis": "darkness", "value": 9}.
- canonicality — walked as THREE doors, one at a time, in prose, each door's options made concrete with examples drawn from the researched profile (a named event they could witness, canon figures they might cross paths with) — never abstract labels. Door 1, the timeline: the same timeline as canon (canon happens around them), an alternate history (canon diverged somewhere — offer a what-if this premise makes tempting), or an inspired universe (the world's rules without its cast; their story is the only story). Door 2, the canon cast (often already answered by the concept beat's seat choice — skip what it settled; skip entirely for inspired): all present and living their canon lives, the protagonist's seat replaced by the player, or canon figures as background NPCs only. Door 3, canon events (skip for inspired): observable (they happen; the player witnesses), influenceable (the player's actions can bend how they unfold — name one they could bend), or background (referenced, never central). Record as JSON: {"timeline_mode": "canon_adjacent" | "alternate" | "inspired", "canon_cast_mode": "full_cast" | "replaced_protagonist" | "npcs_only", "event_fidelity": "observable" | "influenceable" | "background"} — plus separate observations for any accepted divergences or forbidden contradictions the player states.
- presentation vocabulary: derive from the premise what expressive formatting fits (diegetic System windows for a Solo Leveling world; bare prose for Berserk) and confirm the feel, not the mechanics.
- suggestion affordance: some players want suggested moves at decision points, some never — ask once, casually. Record with the CHOSEN value first: content must BEGIN with exactly "default_on", "on_request_only", or "never" — any color after it.
- tier selection: this beat NEVER appears in the opening — it arrives here, at its own beat, once the story is worth pricing. Present the model menus in plain terms — narration (the writer): Sonnet 5 (excellent, standard cost) / Opus 4.8 (deeper, ~2x) / Fable 5 (the frontier, ~3x, with automatic fallback protection); judgment and probe tiers likewise. Their pick is their cost/intelligence throttle and they can change it anytime — note that changing later resets the story's prompt cache and may shift the voice slightly (a "studio handoff"). Record with kind "tier_selection", content as JSON: {"narration": "claude-sonnet-5" | "claude-opus-4-8" | "claude-fable-5", "judgment": "claude-haiku-4-5" | "claude-sonnet-5" | "claude-opus-4-8", "probe": "claude-haiku-4-5" | "claude-sonnet-5"}.
- the protagonist's identity (M2 C4 — the campaign compiled a cast row literally named "The Protagonist (unnamed)" once; never again): their NAME is part of setting the table — ask naturally, in the premise's own register, never as a form field. Record kind "pc_name" with the CHOSEN name first: content must BEGIN with the exact name — any color after it. If the player explicitly wants the name to emerge in play, that is their word: record pc_name with content beginning exactly "deferred" plus their reasoning. Also draw out, as conversation (2-3 beats, never a checklist): who is already IN their life (extant relationships become live threads) and what past presses on them (backstory hooks become the Director's seed material) — record as cast_facts. Age is texture: gather it only when the premise makes it load-bearing.
- world facts the player asserts are WORLD-BUILDING, always: record them (kind "world_fact" / "cast_fact"). The player's words are never just answers to your questions. Keep identities LINKED: if the player names someone previously discussed by role, record the link explicitly ("Mother's name is Milia — same person as the prior Mother facts"); if they reveal something they earlier deferred, record the fact and say in it that it resolves the earlier deferral — a resolved question must never survive as an open one.
- the player themselves: what they loved and when, who they were when it found them, the patterns in what lights them up — record durable taste observations (kind "player_taste") as they surface. These follow the player across campaigns; a returning player is a regular, not a stranger.

STEERING HONESTY. If their stated taste and their actual choices diverge, you may name it once, gently ("you keep saying quiet, but you keep choosing loud — want me to trust the choices?"). Their answer wins.

BOUNDARIES. Details the player defers are recorded as deferred (kind "deferred") — you NEVER improvise them; they are the Director's territory in play. You do not write the story here; you set the table for it.

WHEN THE TABLE IS SET — spark recorded, finitude chosen, intensity contract gathered, tiers picked, calibration settled, the protagonist NAMED (or their name explicitly deferred by the player), their CONCEPT gathered (or explicitly deferred the same way) — call propose_contract. Its result carries any OPEN ITEMS (deferred details, resolutions the compiler had to guess at): weave them honestly into your one warm summary paragraph — the player must recognize themselves in it AND see what is being left open — then wait. If they correct anything, keep talking; the contract waits.`;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const ObservationKind = z.enum([
  "spark",
  "finitude",
  "pc_name",
  "pc_concept",
  "pc_power_tier",
  "framing_choice",
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
      "Signal the table is set: spark, finitude, intensity contract, tier selection, and calibration are all recorded, the protagonist is named with a concept (or the player explicitly deferred either), and the player has recognized themselves in your summary. Compilation runs after this.",
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
    // M2 C4: the gate runs HERE, deterministically, before the player is told
    // the table is set — and the compile's guesses/deferrals surface as OPEN
    // ITEMS for the conductor's summary. The compiler never ships a silent guess.
    const { gapVerdict, resolveObservations } = await import("./compiler");
    const resolved = resolveObservations(draft.observations);
    const gaps = gapVerdict(resolved, draft.profileIds.length > 0);
    if (gaps.length > 0) {
      draft.readyToCompile = false;
      return JSON.stringify({
        ready: false,
        gaps,
        guidance: "The table is NOT set — gather these before proposing again.",
      });
    }
    draft.readyToCompile = true;
    emit({ type: "ready_to_compile" });
    return JSON.stringify({
      ready: true,
      open_items: resolved.deferred,
      guidance:
        "The table is set. Weave the open items honestly into your summary — the player sees what stays open. Compilation runs when they confirm.",
    });
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
        | {
            canonical_dna?: Record<string, number>;
            director_personality?: string;
            ip_mechanics?: { power_distribution?: Record<string, string> };
          }
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
        // SV3: the POWER TIER beat's baseline — the beat walks the choice
        // against THIS, and layout gaps against the same field (it nests
        // under ip_mechanics in the stored Profile). Without it the
        // conductor's baseline is a guess and the SZ-designed gap and the
        // played gap become two different numbers.
        power_distribution: p?.ip_mechanics?.power_distribution,
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
    // C9: 1h TTL — SZ think-time is the same human as play think-time.
    { type: "text", text: CONDUCTOR_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } },
  ];
  if (taste.length > 0) {
    system.push({
      type: "text",
      text: `RETURNING PLAYER. Taste notes from past campaigns — greet them like a regular, and hold these LIGHTLY: they are who this player has been at other tables, not who they are being today. Recognition, never presumption — do not frame the new campaign through a past one's preferences, and never make the player push back against an assumption to claim a departure. These are material for questions ("same appetite as last time, or something different?"), never defaults; what the player says THIS time outranks every line below. Never recite the list back:\n${taste.map((t) => `- ${t}`).join("\n")}`,
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
      // A player-facing prose composer; thinking headroom is added structurally
      // (computeEffectiveMaxTokens). A ceiling, not a target — only produced
      // tokens bill (the C1 NAA lesson: a flat 2k once truncated a reply live).
      maxTokens: PROSE_COMPOSER,
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
    // A clipped conductor turn is still surfaced (the conversation continues),
    // but the clip is honest, not silent (M2R2 §6).
    if (result.message.stop_reason === "max_tokens") {
      console.warn("[sz] conductor turn truncated at max_tokens — surfacing clipped reply", {
        campaignId,
        round,
      });
    }
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
