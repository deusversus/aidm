import { getDb } from "@/lib/db";
import { modelCalls } from "@/lib/db/schema";
import {
  KNOWLEDGE_CUTOFF_YEAR,
  buildFieldSources,
  coverageGates,
  deriveTrust,
  mechanicsImplied,
} from "@/lib/research/trust";
import { SEARCH_TOPICS, searchIdentity, searchTopics } from "@/lib/research/websearch";
import { and, eq, gte, sql } from "drizzle-orm";
import { loadFoundingDefect } from "../golden/founding-defect";
import type { Suite, SuiteResult } from "../types";

/**
 * The thin-IP drill (M3R3 verification). The founding defect was a profile
 * that shipped at asserted confidence 90 with zero fetched pages and "scrape
 * is not viable" in its own notes. This drill proves the four organs that had
 * to exist for that to be impossible — two of them LIVE, because no local
 * assertion can prove that a search fired, cited, or refused.
 *
 * What it deliberately is NOT: a full researchTitle walk. That would cost
 * $0.50+ and write a real row into the shared `profiles` table on every
 * invocation, so the end-to-end walk is a one-time live regression run, not a
 * recurring eval. This drill buys two search calls and asserts the rest at $0.
 *
 * Verdicts are THREE-way, schema-grammar's discipline (a canary that greens
 * on a transport error is worse than no canary):
 *   - the organ answered wrong                      → FAIL
 *   - the organ answered right                      → PASS
 *   - auth / rate limit / network / nothing consulted → UNPROVEN = FAIL
 *     (the suite must never read green on evidence it did not collect).
 *
 * Cost: two live search calls at the research tier (Sonnet judgment — never
 * Fable, never in CI: requiresLlm excludes this from the deterministic gate),
 * ~$0.10–0.20/run dominated by the $10/1k search fee and the result tokens.
 * Metered from the ledger and printed, like schema-grammar.
 */

/** No work exists behind this name. The desk must say so out loud. */
const NONEXISTENT_TITLE = "Zxqv Blorptha Chronicles 9999";
/** Densely covered on the live web — a dry harvest here is a real signal. */
const GROUNDED_TITLE = "Frieren: Beyond Journey's End";

/** Transport/quota failures — evidence NOT collected; must not read green. */
const UNPROVEN =
  /401|403|429|5\d{2}|overloaded|rate.?limit|api.?key|ENOTFOUND|ECONN|ETIMEDOUT|fetch failed|network/i;

type Verdict = "pass" | "fail" | "unproven";
type Record_ = (organ: string, verdict: Verdict, msg: string) => void;

/**
 * The conductor's profile_health literal (sz/conductor.ts), mirrored. The
 * drill asserts the SHAPE the player's ear depends on: seven keys that must
 * survive JSON.stringify, because a key that arrives undefined is dropped
 * silently and the conductor then discloses nothing at all.
 */
const PROFILE_HEALTH_KEYS = [
  "derived_confidence",
  "method",
  "pages_fetched",
  "post_cutoff",
  "defective",
  "grounding",
  "coverage_gaps",
] as const;

/** (c) THE GATES FIRE AT $0 — pure, no model, the founding-defect shape. */
function gatesFireAtZeroCost(record: Record_): void {
  const gates = coverageGates({
    mechanicsImplied: true,
    powerSystemPresent: false,
    statsCanonical: false,
    contentChars: 0,
    pagesFetched: 0,
  });
  const trust = deriveTrust({
    startYear: KNOWLEDGE_CUTOFF_YEAR,
    pagesFetched: 0,
    contentChars: 0,
    sourcesConsulted: ["anilist"],
    powerSystemPresent: false,
    powerSystemFromPages: false,
    statsCanonical: false,
    statConfidence: 0,
    voiceQuoteCharacters: 0,
    mechanicsImplied: true,
    method: "api_wiki",
    fieldSources: buildFieldSources({
      identityOrigin: "anilist",
      tonalSource: null,
      settingSource: null,
      statMappingSource: null,
      powerSystemSource: null,
      voiceSource: null,
    }),
    fieldPages: {},
    defects: gates.defects,
    grounding: "no_claims",
  });

  const problems: string[] = [];
  if (trust.derived_confidence > 25) {
    problems.push(
      `derived_confidence ${trust.derived_confidence} on zero pages past the cutoff — the founding shape must derive thin`,
    );
  }
  if (!trust.defective) problems.push("defective=false on a mechanics IP with no power system");
  const first = trust.coverage_gaps[0] ?? "";
  if (!first.startsWith("DEFECT:")) {
    problems.push(`coverage_gaps leads with "${first.slice(0, 60)}" — a DEFECT must lead`);
  }

  // The player-facing hop: the conductor builds this object and returns it as
  // a JSON string. An undefined key vanishes in transit, silently.
  const health = {
    derived_confidence: trust.derived_confidence,
    method: trust.method,
    pages_fetched: trust.pages_fetched,
    post_cutoff: trust.post_cutoff,
    defective: trust.defective,
    grounding: trust.grounding,
    coverage_gaps: trust.coverage_gaps,
  };
  const wire = JSON.parse(JSON.stringify(health)) as Record<string, unknown>;
  for (const key of PROFILE_HEALTH_KEYS) {
    if (!(key in wire)) {
      problems.push(`profile_health lost "${key}" through JSON.stringify — undefined on the wire`);
    }
  }
  if (wire.defective !== true) problems.push("profile_health.defective did not survive as true");
  if (typeof wire.grounding !== "string") problems.push("profile_health.grounding is not a state");
  if (!Array.isArray(wire.coverage_gaps) || wire.coverage_gaps.length === 0) {
    problems.push("profile_health.coverage_gaps reached the conductor empty");
  }

  if (problems.length > 0) record("gates at $0", "fail", problems.join("; "));
  else
    record(
      "gates at $0",
      "pass",
      `confidence ${trust.derived_confidence}, ${gates.defects.length} defect(s) leading ${trust.coverage_gaps.length} gap(s), profile_health intact on the wire`,
    );
}

/** (d) THE FOUNDING ROW STAYS DEAD — the captured row through legacy gating. */
function foundingRowStaysDead(record: Record_): void {
  const row = loadFoundingDefect();
  const mech = row.ip_mechanics;
  // The legacy shape exactly as research.ts's cached door derives it: the
  // mechanics rules over the walked TAGS, the text floor sitting out because
  // no cached row ever stored the page text it would measure.
  const implied = mechanicsImplied(mech.world_setting.genre, row.anilist_tags);
  const gates = coverageGates({
    mechanicsImplied: implied,
    powerSystemPresent: mech.power_system !== null,
    statsCanonical: mech.stat_mapping.has_canonical_stats,
    contentChars: 0,
    pagesFetched: row.research_provenance.pages_fetched,
    skipTextFloor: true,
  });

  const problems: string[] = [];
  if (!implied) {
    problems.push(
      `mechanicsImplied=false over genres [${mech.world_setting.genre.join(", ")}] + ${row.anilist_tags.length} tags — the dungeon signal went missing`,
    );
  }
  if (!gates.defective) {
    problems.push(
      "the founding row reads CLEAN through the legacy gates — the defect this milestone exists for is back",
    );
  }
  if (problems.length > 0) record("founding row", "fail", problems.join("; "));
  else
    record(
      "founding row",
      "pass",
      `the row that shipped at asserted confidence ${row.research_provenance.confidence} on ${row.research_provenance.pages_fetched} pages is DEFECTIVE: ${gates.defects.length} gate(s)`,
    );
}

/** (a) IDENTITY REFUSAL IS HONEST — live; §8's existence-by-citation. */
async function identityRefusalIsHonest(record: Record_): Promise<void> {
  try {
    const rescue = await searchIdentity(NONEXISTENT_TITLE);
    if (rescue.identity.exists) {
      record(
        "identity refusal",
        "fail",
        `exists=true for "${NONEXISTENT_TITLE}" — the desk minted a synthetic identity for a work that does not exist (${rescue.searchCount} searches, ${rescue.searchedUrls.length} sources)`,
      );
      return;
    }
    // exists=false is trivially true when nothing was consulted: the §8 guard
    // forces the demotion. Real, but not a LIVE verdict — and this suite
    // exists to prove the live one.
    if (rescue.searchCount === 0 && rescue.searchedUrls.length === 0) {
      record(
        "identity refusal",
        "unproven",
        "exists=false with zero searches and zero sources — the citation guard spoke, the live chain did not",
      );
      return;
    }
    record(
      "identity refusal",
      "pass",
      `exists=false after ${rescue.searchCount} live search(es) over ${rescue.searchedUrls.length} source(s)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record("identity refusal", UNPROVEN.test(msg) ? "unproven" : "fail", msg.slice(0, 160));
  }
}

/** (b) THE TOPIC HARVEST IS CITED OR NOTHING — live; the citation gate. */
async function topicHarvestIsCitedOrNothing(record: Record_): Promise<void> {
  const topic = SEARCH_TOPICS.find((t) => t.key === "characters");
  if (!topic) {
    record("topic harvest", "fail", "SEARCH_TOPICS no longer carries a characters topic");
    return;
  }
  try {
    const harvest = await searchTopics(GROUNDED_TITLE, [topic]);
    const backing = harvest.topicUrls[topic.key] ?? [];

    if (harvest.pages.length === 0) {
      // A dry return is the gate WORKING — an ungrounded answer refused. It
      // only proves that if searches actually fired.
      if (harvest.searchCount === 0) {
        record(
          "topic harvest",
          "unproven",
          "zero pages AND zero searches — nothing fired, so nothing was gated",
        );
        return;
      }
      record(
        "topic harvest",
        "pass",
        `dry return after ${harvest.searchCount} search(es) — the citation gate refused an ungrounded page`,
      );
      return;
    }

    const problems: string[] = [];
    for (const page of harvest.pages) {
      if (page.origin !== "web_search") {
        problems.push(
          `page origin "${page.origin}" — a searched page must never wear the wiki label`,
        );
      }
      if (page.url.trim().length === 0) problems.push("page url is empty — asserted provenance");
      if (page.text.length < 200) {
        problems.push(
          `page text ${page.text.length} chars — below the harvest's own substance bar`,
        );
      }
    }
    if (backing.length === 0) {
      problems.push(
        `topicUrls["${topic.key}"] is empty — a page landed with no live source behind it; field_pages would lie`,
      );
    }
    if (problems.length > 0) record("topic harvest", "fail", problems.join("; "));
    else
      record(
        "topic harvest",
        "pass",
        `${harvest.pages.length} cited page(s), ${harvest.pages[0]?.text.length ?? 0} chars, ${backing.length} backing url(s), ${harvest.searchCount} search(es)`,
      );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    record("topic harvest", UNPROVEN.test(msg) ? "unproven" : "fail", msg.slice(0, 160));
  }
}

export const thinIpDrill: Suite = {
  name: "thin-ip-drill",
  gate: "M3R3 verification (thin-IP drill: gates fire, health surfaces, the fallback chain's live organs answer)",
  requiresLlm: true,
  async run(): Promise<SuiteResult> {
    const details: string[] = [];
    const failures: string[] = [];

    const record: Record_ = (organ, verdict, msg) => {
      if (verdict === "pass") details.push(`✓ ${organ} — ${msg}`);
      else if (verdict === "fail") failures.push(`${organ}: ${msg}`);
      else failures.push(`${organ}: UNPROVEN (evidence not collected) — ${msg}`);
    };

    // The $0 half first: it must be measured even when the live half cannot
    // run at all, and a broken gate makes the live spend pointless.
    gatesFireAtZeroCost(record);
    foundingRowStaysDead(record);

    if (!process.env.DATABASE_URL) {
      // Spend without the ledger is the one thing the substrate forbids, and
      // the drill's cost print reads the ledger. No DB, no live half.
      details.push("DATABASE_URL not set — the live half would spend unmetered; not run");
      return {
        name: this.name,
        gate: this.gate,
        status: failures.length > 0 ? "fail" : "skipped",
        details,
        failures,
      };
    }

    // Attribution is by TIME + phase: searchIdentity/searchTopics take no
    // campaignId (they run before any campaign exists), so there is no id to
    // sum on. The 30s back-off absorbs app/DB clock skew; a concurrent
    // research run on the same database would inflate the print, which is a
    // reported figure, not a gate.
    const startedAt = new Date(Date.now() - 30_000);
    try {
      await identityRefusalIsHonest(record);
      await topicHarvestIsCitedOrNothing(record);
    } finally {
      const [{ total, searches } = { total: "0", searches: "0" }] = await getDb()
        .select({
          total: sql<string>`coalesce(sum(${modelCalls.costUsd}), 0)`,
          searches: sql<string>`coalesce(sum(${modelCalls.webSearchRequests}), 0)`,
        })
        .from(modelCalls)
        .where(and(gte(modelCalls.createdAt, startedAt), eq(modelCalls.phase, "research")));
      const line = `metered cost: $${Number(total).toFixed(4)} (${Number(searches)} billable searches)`;
      details.push(line);
      console.log(`[thin-ip-drill] ${line}`);
    }

    return {
      name: this.name,
      gate: this.gate,
      status: failures.length === 0 ? "pass" : "fail",
      details,
      failures,
    };
  },
};
