/**
 * C4 smoke: Voyage embedding round-trip at the frozen model + dimensions,
 * metered in the same pipeline. Run: pnpm spike:embed  (needs VOYAGE_API_KEY)
 */
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "@/lib/llm/embedding-config";
import { cosineSimilarity, embedTexts } from "@/lib/llm/voyage";
import { flushLangfuse } from "@/lib/observability/langfuse";

const texts = [
  "The Syndicate has a new leader called Slayer.",
  "A new boss has taken over the crime syndicate.",
  "Jet keeps bonsai trees on the Bebop.",
];

const [a, b, c] = await embedTexts(texts, { inputType: "document" });
if (!a || !b || !c) throw new Error("embedding count mismatch");

console.log(`model: ${EMBEDDING_MODEL} @ ${a.length} dims (frozen: ${EMBEDDING_DIMENSIONS})`);
const simAB = cosineSimilarity(a, b);
const simAC = cosineSimilarity(a, c);
console.log(`sim(syndicate, syndicate-paraphrase) = ${simAB.toFixed(4)}`);
console.log(`sim(syndicate, bonsai)               = ${simAC.toFixed(4)}`);
if (simAB <= simAC) {
  process.exitCode = 1;
  console.error("smoke_embed: FAIL — paraphrase should be nearer than unrelated text");
} else {
  console.log("smoke_embed: OK — check the model_calls row (provider=voyage)");
}
await flushLangfuse();
