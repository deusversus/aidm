/**
 * Research CLI (M1-C2): pnpm research "<title>"
 * Live AniList + wiki fetches and judgment-tier synthesis (traced +
 * metered; roughly $0.30–1.00 per standard-scope title on Sonnet).
 */
import { getDb } from "@/lib/db";
import { flushLangfuse } from "@/lib/observability/langfuse";
import { researchTitle } from "@/lib/research/research";

const args = process.argv.slice(2).filter((a) => a !== "--skip-corpus");
const skipCorpus = process.argv.includes("--skip-corpus");
const title = args.join(" ").trim();
if (!title) {
  console.error('usage: pnpm research "<title>" [-- --skip-corpus]');
  process.exit(1);
}

const report = await researchTitle(getDb(), title, { skipCorpus });
console.log(JSON.stringify(report, null, 2));
await flushLangfuse();
console.log(
  `research: OK — profile "${report.profileId}" persisted with ${report.chunksWritten} canon chunks`,
);
process.exit(0);
