/**
 * MockLLM — unified mock infrastructure for LLM provider calls.
 * See `docs/plans/mockllm.md` for the full design.
 *
 * Phase A (this commit): scaffold + fixture registry + matcher + synth.
 * Phase B: HTTP server + non-streaming replay.
 * Phase C: streaming.
 * Phase D: Agent SDK queryFn swap.
 * Phase E: unified test helpers + migration from inline fakes.
 * Phase F: record mode + seed fixtures.
 */

export type {
  AnthropicMessageResponse,
  AnthropicStopReason,
  MatchOutcome,
  MatchRules,
  MockLlmFixture,
  MockProvider,
  RequestSignature,
  StreamingChunk,
  StreamingConfig,
} from "./types";

export {
  computeRequestHash,
  emptyRegistry,
  type FixtureRegistry,
  loadFixtures,
  matchFixture,
  signatureFromAnthropicBody,
} from "./fixtures";

export {
  appearsToWantStructuredOutput,
  synthesizeAnthropicResponse,
  synthesizeCostUsd,
} from "./synth";

export { estimateCostUsd, pricingFor, type ModelPricing, type UsageStats } from "./pricing";
