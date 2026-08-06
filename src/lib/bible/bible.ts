import type { Db } from "@/lib/db";
import { notTombstoned } from "@/lib/db/helpers";
import { campaigns, criticalFacts, entities, turns } from "@/lib/db/schema";
import { EVOLUTION_CATEGORY } from "@/lib/types/direction";
import { HARD_LINE_PREFIX, PremiseContract, type WorldComponent } from "@/lib/types/premise";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

/**
 * The Series Bible (blueprint §9.1, C9): the campaign's living reference —
 * Premise Contract essentials + cast + world facts + the spark. First
 * edition REVEALS after the cold open (≥1 complete turn); before that the
 * page teases rather than spoils. Grows via universal ingestion (§5.4):
 * player-minted entities appear WITH provenance. Read-only at M1 (studio
 * surfaces stage at M4); the ledger/cost page is CUT per the plan.
 */

export interface BibleEntry {
  name: string;
  block: string;
  /** Raw provenance tag + the player-minted flag the UI badges. */
  provenance: string;
  playerMinted: boolean;
  turnId: number;
}

export interface BibleComposition {
  /** False until the cold open has landed (≥1 complete turn). */
  revealed: boolean;
  title: string;
  /** The spark, verbatim — the campaign's central question (§8). */
  spark: string;
  /** Premise essentials safe for the player-facing page (never the axes-as-numbers dump). */
  premise: {
    finitude: string;
    worldName?: string;
    powerSystem?: string;
    /** The LIVE hard lines, prefix stripped — see `readHardLines`. */
    hardLines: string[];
    deathPhysics?: string;
    lethalityPosture?: string;
    controlKey?: string;
  };
  cast: BibleEntry[];
  factions: BibleEntry[];
  locations: BibleEntry[];
  threads: BibleEntry[];
  /** Critical-layer world facts (categories sz_fact + promoted; contract rows excluded — they render under premise). */
  worldFacts: Array<{ content: string; provenance: string; playerMinted: boolean }>;
  /**
   * §7.1 retoolings: player-ratified season evolutions, dated, oldest first —
   * the record of the premise changing on the player's own word. Its writer is
   * direction/evolution.ts's ratify answer (category "evolution").
   */
  evolutions: Array<{ content: string; turnId: number }>;
}

/**
 * Player-minted = provenance "player_assertion" (§5.4 universal ingestion's
 * world-assertion channel). Pins/overrides are player acts too, but they are
 * NOT entities and never enter the catalog — the composer's minted set is
 * exactly the entities and critical facts the player authored, badged so the
 * bible reads as the shared review gate it is (§9.1).
 */
const PLAYER_MINTED = "player_assertion";

/**
 * A displayable world label. The World component (§4.1, premise.ts) carries
 * no dedicated proper-name field — the campaign title is the story's name.
 * The nearest displayable world identity is world_setting: its genre(s) and
 * time period. Undefined when the setting names neither. (power_system.name
 * is the separate powerSystem essential.)
 */
function worldLabel(world: WorldComponent): string | undefined {
  const setting = world.world_setting;
  const genres = setting.genre.filter((g) => g.trim().length > 0);
  const parts: string[] = [];
  if (genres.length > 0) parts.push(genres.join(", "));
  if (setting.time_period?.trim()) parts.push(setting.time_period.trim());
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * A layer-9 critical fact as the composer reads it.
 */
interface FactRow {
  content: string;
  category: string;
  provenance: string;
  turnId: number;
}

/**
 * Hard lines, from the LIVE record (ratified 2026-08-05) — not from the
 * contract's own `intensity.hard_lines` copy, which is what this read replaced.
 *
 * They exist twice by design. The signed contract (§8) is the ARCHIVE: what the
 * player and the studio agreed at Session Zero, untouched forever (§13.4 keeps
 * it that way — only tiers and suggestion_affordance are writable post-compile).
 * The critical_facts rows minted at compile are the RECORD: what the pen
 * actually reads every turn, and the thing a booth correction retires and
 * replaces (M3R2 C4). Rendering the archive on the Bible page meant a player
 * who corrected an inverted hard line — the 2026-08-03 founding incident — kept
 * being shown the exact wrong line they had just fixed, with no path by which
 * it could ever change. The Bible tells the truth about the campaign AS PLAYED
 * (its own charter, M2R R4's review gate); a second displayed copy that
 * corrections cannot reach is not a second view, it is a lie with a nicer font.
 *
 * The query shape, and why each clause is or isn't there:
 *   - category "contract" + the `HARD_LINE_PREFIX` — the compiler mints the
 *     whole intensity contract under one category (finitude, death physics,
 *     lethality, control key ride along); the prefix is what makes a row a hard
 *     line. `ingest.ts` keeps a corrected replacement wearing it.
 *   - notTombstoned — the ONLY liveness filter needed. A retire-and-replace
 *     tombstones the retired row in place (retiredAtTurn is the rewind anchor,
 *     not a read filter), so a `retiredAtTurn IS NULL` clause would be both
 *     redundant and wrong: it would hide replacement rows on a re-correction.
 *   - demotedAt — inert here, kept only because it rides the shared read. §6.3
 *     is promoted-only (director.ts): a contract row came from the player, has
 *     no semantic copy to fall back to, and is explicitly never demotable.
 *
 * Order: turnId, then the ARCHIVE's authored order, then content. All original
 * mints share turnId 0 (SZ_ROW), so a bare content tiebreak rendered the
 * player's lines ALPHABETICALLY while the fallback kept their authored order —
 * the two paths disagreed on the same campaign (audit F3). The archive is in
 * scope and its index is exactly the authored order, so turn-0 rows recover
 * it; corrected lines carry the correction's turn and sort last (the record's
 * own chronology); rows the archive no longer names fall back to content.
 */
function readHardLines(facts: FactRow[], contract: PremiseContract): string[] {
  const authored = new Map(contract.intensity.hard_lines.map((l, i) => [l.trim(), i]));
  const rank = (line: string) => authored.get(line) ?? Number.MAX_SAFE_INTEGER;
  const live = facts
    .filter((f) => f.category === "contract" && f.content.startsWith(HARD_LINE_PREFIX))
    .map((f) => ({ turnId: f.turnId, line: f.content.slice(HARD_LINE_PREFIX.length).trim() }))
    .filter((f) => f.line.length > 0)
    .sort(
      (a, b) => a.turnId - b.turnId || rank(a.line) - rank(b.line) || a.line.localeCompare(b.line),
    )
    .map((f) => f.line);
  if (live.length > 0) return live;
  // The fallback (never silently blank a section with real content behind it),
  // presented as-is with no staleness marker — all-or-nothing is the ruled
  // shape. The zero case is NOT legacy-only (audit F2): post-C4 corrections
  // always leave a live line (retire-and-replace + the rewind's retire
  // anchor), but rows retired before `retiredAtTurn` existed have no anchor —
  // live data holds one such campaign (86135b1f, checked 2026-08-05: the
  // founding incident's hand-SQL retirement + a rewind killed both rows, the
  // archive is the only copy left, and it carries the INVERTED line). That
  // record needs repair, not another code path; what this line guarantees is
  // that a player whose live rows are gone still sees lines rather than a
  // silently empty section.
  return contract.intensity.hard_lines;
}

/**
 * Compose the Bible from the live layers: campaign row (contract), entities
 * catalog (active, not tombstoned, grouped by entityType; dismissed cast
 * excluded), critical facts (not demoted, not tombstoned). Returns null when
 * the campaign is missing or its contract cannot be parsed — there is no
 * bible without a premise. Before the cold open lands, the composition
 * returns with revealed:false and EMPTY layers: the page teases without
 * leaking cast the player hasn't yet lived.
 */
export async function composeBible(db: Db, campaignId: string): Promise<BibleComposition | null> {
  const [campaign] = await db
    .select({ title: campaigns.title, premiseContract: campaigns.premiseContract })
    .from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!campaign) return null;

  const parsed = PremiseContract.safeParse(campaign.premiseContract);
  if (!parsed.success) return null;
  const contract = parsed.data;

  // Reveal gate (§9.1): the bible is what you find in your hands when you
  // surface from the first scene — not before.
  const [firstComplete] = await db
    .select({ id: turns.id })
    .from(turns)
    .where(and(eq(turns.campaignId, campaignId), eq(turns.status, "complete")))
    .limit(1);
  const revealed = Boolean(firstComplete);

  // One read for every critical-fact consumer on this page — hard lines
  // (premise section), world facts, and retoolings — split below by category.
  // It runs BEFORE the reveal gate because the hard lines are scalar: the
  // premise essentials compose either side of the cold open, and only the
  // lived layers are withheld.
  const facts: FactRow[] = await db
    .select({
      content: criticalFacts.content,
      category: criticalFacts.category,
      provenance: criticalFacts.provenance,
      turnId: criticalFacts.turnId,
    })
    .from(criticalFacts)
    .where(
      and(
        eq(criticalFacts.campaignId, campaignId),
        isNull(criticalFacts.demotedAt),
        notTombstoned(criticalFacts),
        // "contract" rows are read for the hard lines and then EXCLUDED from
        // world facts below — the premise section carries the intensity
        // contract (M2R R4). "evolution" rides along and splits out too: a
        // retooling is the premise's own history, not a fact about the world
        // (§7.1, M3 C4).
        inArray(criticalFacts.category, ["contract", "sz_fact", "promoted", EVOLUTION_CATEGORY]),
      ),
    )
    .orderBy(asc(criticalFacts.turnId), asc(criticalFacts.content));

  const scalar = {
    revealed,
    title: campaign.title,
    spark: contract.spark,
    premise: {
      finitude: contract.finitude,
      worldName: worldLabel(contract.active.world),
      powerSystem: contract.active.world.power_system?.name,
      hardLines: readHardLines(facts, contract),
      // §9.1 review gate (M2R R4): the intensity contract the player set at
      // SZ is theirs to see — it was collected, enforced, and shown nowhere.
      // These three still read the ARCHIVE. The 2026-08-05 ruling names hard
      // lines, and they are the line the booth actually gets corrected (the
      // founding incident); the compiler mints these three as contract rows
      // too, so a correction COULD retire one and this display would go stale
      // the same way. Moving them takes a decision, not a patch — each carries
      // its own mint label ("Death physics: …") that a live read would have to
      // parse, and the ledger is closed to unratified mechanism.
      deathPhysics: contract.intensity.death_physics,
      lethalityPosture: contract.intensity.lethality_posture,
      controlKey: contract.intensity.control_key?.circumstances,
    },
  };

  if (!revealed) {
    return {
      ...scalar,
      cast: [],
      factions: [],
      locations: [],
      threads: [],
      worldFacts: [],
      evolutions: [],
    };
  }

  const rows = await db
    .select({
      name: entities.name,
      entityType: entities.entityType,
      block: entities.block,
      provenance: entities.provenance,
      turnId: entities.turnId,
    })
    .from(entities)
    .where(
      and(
        eq(entities.campaignId, campaignId),
        eq(entities.status, "active"),
        notTombstoned(entities),
      ),
    )
    // First-met first (§9.1 "grows via ingestion"): turnId ascending, name as
    // a stable tiebreak within a turn.
    .orderBy(asc(entities.turnId), asc(entities.name));

  const toEntry = (r: (typeof rows)[number]): BibleEntry => ({
    name: r.name,
    block: r.block,
    provenance: r.provenance,
    playerMinted: r.provenance === PLAYER_MINTED,
    turnId: r.turnId,
  });

  return {
    ...scalar,
    cast: rows.filter((r) => r.entityType === "npc").map(toEntry),
    factions: rows.filter((r) => r.entityType === "faction").map(toEntry),
    locations: rows.filter((r) => r.entityType === "location").map(toEntry),
    threads: rows.filter((r) => r.entityType === "thread").map(toEntry),
    worldFacts: facts
      .filter((f) => f.category === "sz_fact" || f.category === "promoted")
      .map((f) => ({
        content: f.content,
        provenance: f.provenance,
        playerMinted: f.provenance === PLAYER_MINTED,
      })),
    evolutions: facts
      .filter((f) => f.category === EVOLUTION_CATEGORY)
      .map((f) => ({ content: f.content, turnId: f.turnId })),
  };
}
