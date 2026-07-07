/**
 * Canon corpus writer (§6 layer 5): cleaned wiki pages → chunks → Voyage
 * embeddings → canon_chunks rows (profile-keyed, cross-campaign, envelope
 * convention turnId 0 / provenance "sz_research"). Re-research replaces the
 * profile's corpus wholesale — the corpus mirrors the wiki, it doesn't
 * accumulate.
 */

import { approxTokens } from "@/lib/blocks/tokens";
import type { Db } from "@/lib/db";
import { canonChunks } from "@/lib/db/schema";
import { embedTexts } from "@/lib/llm/voyage";
import { eq } from "drizzle-orm";
import type { WikiPage } from "./wiki";

const CHUNK_TARGET_TOKENS = 1_000;

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
          provenance: "sz_research",
          confidence: 1,
        })),
      );
    }
  });
  return { chunks: entries.length };
}
