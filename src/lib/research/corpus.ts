/**
 * Canon corpus writer (§6 layer 5): cleaned pages → chunks → Voyage
 * embeddings → canon_chunks rows (profile-keyed, cross-campaign, envelope
 * convention turnId 0 / provenance per origin). Re-research replaces the
 * profile's corpus wholesale — the corpus mirrors the wiki, it doesn't
 * accumulate. Player-pasted canon takes the separate `writePlayerCanon` path
 * below precisely BECAUSE of that wholesale replace.
 */

import { approxTokens } from "@/lib/blocks/tokens";
import type { Db } from "@/lib/db";
import { canonChunks } from "@/lib/db/schema";
import { embedTexts } from "@/lib/llm/voyage";
import { and, eq, inArray } from "drizzle-orm";
import type { CanonicalPageType, WikiPage } from "./wiki";

export const CHUNK_TARGET_TOKENS = 1_000;

/** Section-aware chunking: split on headers, merge small parts up to target. */
export function chunkPage(page: WikiPage): { title: string; content: string }[] {
  const sections = page.text.split(/\n(?=#{2,3}\s)/);
  const chunks: { title: string; content: string }[] = [];
  let buffer = "";
  for (const section of sections) {
    const candidate = buffer ? `${buffer}\n${section}` : section;
    if (approxTokens(candidate) > CHUNK_TARGET_TOKENS && buffer) {
      chunks.push({ title: page.title, content: buffer.trim() });
      buffer = section;
    } else {
      buffer = candidate;
    }
  }
  if (buffer.trim().length > 0) chunks.push({ title: page.title, content: buffer.trim() });
  // Oversized single sections get hard-split by paragraphs.
  return chunks.flatMap((c) => {
    if (approxTokens(c.content) <= CHUNK_TARGET_TOKENS * 1.5) return [c];
    const paras = c.content.split(/\n\n+/);
    const out: { title: string; content: string }[] = [];
    let buf = "";
    for (const p of paras) {
      const cand = buf ? `${buf}\n\n${p}` : p;
      if (approxTokens(cand) > CHUNK_TARGET_TOKENS && buf) {
        out.push({ title: c.title, content: buf });
        buf = p;
      } else {
        buf = cand;
      }
    }
    if (buf) out.push({ title: c.title, content: buf });
    return out;
  });
}

/** Merge adjacent parts up to the target; a part that alone exceeds it stands alone. */
function mergeParts(
  title: string,
  parts: string[],
  joiner: string,
): { title: string; content: string }[] {
  const out: { title: string; content: string }[] = [];
  let buffer = "";
  for (const part of parts) {
    const candidate = buffer ? `${buffer}${joiner}${part}` : part;
    if (approxTokens(candidate) > CHUNK_TARGET_TOKENS && buffer) {
      out.push({ title, content: buffer });
      buffer = part;
    } else {
      buffer = candidate;
    }
  }
  if (buffer.trim().length > 0) out.push({ title, content: buffer });
  return out;
}

/** The hard ceiling every returned chunk honors — the wiki path's own bar. */
const MAX_CHUNK_TOKENS = CHUNK_TARGET_TOKENS * 1.5;

/**
 * The oversize cascade, in order. Each stage is tried only on a part that is
 * ALREADY over the ceiling, never on the whole text — the M3R3 C2 review's
 * defect was gating the single-newline split on the GLOBAL part count, so one
 * blank line anywhere ("Characters\n\n" above a 400-line cast list) disabled
 * it and the punctuation-free body survived as one ~6.8k-token chunk.
 */
const OVERSIZE_STAGES: { pattern: RegExp; joiner: string }[] = [
  { pattern: /(?<=[.!?…。！？])\s+/, joiner: " " },
  { pattern: /\n+/, joiner: "\n" },
];

/**
 * Last resort: a run with no sentence boundary and no line break at all (a
 * comma-separated roster, a wall of CJK without terminal punctuation). Sliced
 * on `approxTokens`' own chars/4 heuristic so the arithmetic can't drift from
 * the measure the ceiling is expressed in.
 */
function hardSlice(title: string, content: string): { title: string; content: string }[] {
  const size = CHUNK_TARGET_TOKENS * 4;
  const out: { title: string; content: string }[] = [];
  for (let i = 0; i < content.length; i += size) {
    const piece = content.slice(i, i + size).trim();
    if (piece.length > 0) out.push({ title, content: piece });
  }
  return out;
}

/**
 * Bound ONE part. Post-condition: nothing returned exceeds MAX_CHUNK_TOKENS.
 * The stage index only ever advances, so the recursion terminates at the hard
 * slice no matter what shape the paste has.
 */
function boundPart(
  title: string,
  content: string,
  stage = 0,
): { title: string; content: string }[] {
  if (approxTokens(content) <= MAX_CHUNK_TOKENS) return [{ title, content }];
  const next = OVERSIZE_STAGES[stage];
  if (!next) return hardSlice(title, content);
  const parts = content
    .split(next.pattern)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) return boundPart(title, content, stage + 1);
  return mergeParts(title, parts, next.joiner).flatMap((c) =>
    boundPart(title, c.content, stage + 1),
  );
}

/**
 * Prose-aware chunking for PASTED material (M3R3 C2). `chunkPage` splits on
 * markdown headers, which a player's paste does not have — a synopsis or a
 * chapter would land as one undivided chunk and retrieve as an all-or-nothing
 * wall. Blank-line paragraphs (falling back to single newlines — the e-reader
 * copy shape, where every line break is a paragraph) merge up to the same
 * target the wiki path uses; anything still over the ceiling then runs the
 * PER-PART cascade above.
 *
 * POST-CONDITION: no returned chunk exceeds 1.5× CHUNK_TARGET_TOKENS, ever —
 * for any input, including material with no punctuation and no line breaks.
 */
export function chunkProse(title: string, text: string): { title: string; content: string }[] {
  const clean = (parts: string[]) => parts.map((p) => p.trim()).filter(Boolean);
  let parts = clean(text.split(/\n\s*\n+/));
  if (parts.length <= 1 && /\n/.test(text)) parts = clean(text.split(/\n+/));
  if (parts.length === 0) return [];

  return mergeParts(title, parts, "\n\n").flatMap((chunk) => boundPart(title, chunk.content));
}

/**
 * The player-canon pseudo-profile: campaign-scoped, never a real profile row.
 */
export function playerCanonProfileId(campaignId: string): string {
  return `player_canon_${campaignId}`;
}

/**
 * Player-supplied canon → corpus chunks (M3R3 C2, L5: for a little-known IP
 * the fan who chose it is the best source the desk has).
 *
 * It lives under its OWN campaign-scoped profileId for three reasons, each
 * load-bearing:
 *   1. `writeCorpus` wholesale-REPLACES a profileId's corpus on every
 *      re-research — sharing the source profile's id would let a later
 *      research run silently eat everything the player pasted.
 *   2. The id self-tags: every reader labels a chunk `[profileId/pageType]`,
 *      so player material is visibly player material wherever it surfaces.
 *   3. Canon profiles are CROSS-CAMPAIGN and cached permanently (§6 layer 5).
 *      One campaign's private truth must never leak into another player's
 *      table through the shared profile (hosted model).
 * Re-supplying the same title replaces that title's rows only — a correction
 * overwrites what it corrects and leaves the rest of the player's canon alone.
 */
export async function writePlayerCanon(
  db: Db,
  campaignId: string,
  entries: { title: string; pageType: CanonicalPageType; text: string }[],
): Promise<{ chunks: number; profileId: string }> {
  const profileId = playerCanonProfileId(campaignId);
  const prepared = entries.flatMap((entry) =>
    chunkProse(entry.title, entry.text).map((chunk) => ({ entry, chunk })),
  );
  if (prepared.length === 0) return { chunks: 0, profileId };

  // Same batching discipline as writeCorpus: embed everything first (the
  // keyless Voyage tier is slow), then replace inside one short transaction.
  const BATCH = 8;
  const embedded: number[][] = [];
  for (let i = 0; i < prepared.length; i += BATCH) {
    const batch = prepared.slice(i, i + BATCH);
    embedded.push(
      ...(await embedTexts(
        batch.map((e) => e.chunk.content),
        { inputType: "document", patience: "research" },
      )),
    );
  }

  const titles = [...new Set(entries.map((e) => e.title))];
  await db.transaction(async (tx) => {
    await tx
      .delete(canonChunks)
      .where(and(eq(canonChunks.profileId, profileId), inArray(canonChunks.title, titles)));
    const BATCH_INSERT = 50;
    for (let i = 0; i < prepared.length; i += BATCH_INSERT) {
      await tx.insert(canonChunks).values(
        prepared.slice(i, i + BATCH_INSERT).map((e, j) => ({
          profileId,
          pageType: e.entry.pageType,
          title: e.chunk.title,
          content: e.chunk.content,
          embedding: embedded[i + j] as number[],
          sourceUrl: "player",
          turnId: 0,
          provenance: "player_supplied",
          confidence: 1,
        })),
      );
    }
  });
  return { chunks: prepared.length, profileId };
}

export async function writeCorpus(
  db: Db,
  profileId: string,
  pages: WikiPage[],
): Promise<{ chunks: number }> {
  const entries = pages.flatMap((page) => chunkPage(page).map((chunk) => ({ page, chunk })));
  if (entries.length === 0) return { chunks: 0 };

  // Embed EVERYTHING first (minutes on the free tier), THEN replace the
  // corpus in one transaction — the delete-to-insert window shrinks from
  // minutes to milliseconds, so a crash can't leave a half-replaced corpus.
  // Batch small enough for Voyage's keyless free tier (10K TPM at ~1K-token
  // chunks); a payment method on the account makes this merely conservative.
  const BATCH = 8;
  const embedded: number[][] = [];
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    embedded.push(
      ...(await embedTexts(
        batch.map((e) => e.chunk.content),
        { inputType: "document", patience: "research" },
      )),
    );
  }

  await db.transaction(async (tx) => {
    await tx.delete(canonChunks).where(eq(canonChunks.profileId, profileId));
    const BATCH_INSERT = 50;
    for (let i = 0; i < entries.length; i += BATCH_INSERT) {
      await tx.insert(canonChunks).values(
        entries.slice(i, i + BATCH_INSERT).map((e, j) => ({
          profileId,
          pageType: e.page.pageType,
          title: e.chunk.title,
          content: e.chunk.content,
          embedding: embedded[i + j] as number[],
          sourceUrl: e.page.url,
          turnId: 0,
          // Per-page, never one blanket label (M3R3 C2): a chunk fabricated
          // from web search is not a wiki chunk, and the provenance column is
          // where that difference has to survive.
          provenance: e.page.origin === "web_search" ? "sz_research_websearch" : "sz_research",
          confidence: 1,
        })),
      );
    }
  });
  return { chunks: entries.length };
}
