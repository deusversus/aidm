// --- Runner (internal utility; exported for advanced callers) ---
export {
  extractJson,
  runStructuredAgent,
  type AgentRunnerConfig,
  type AgentRunnerDeps,
} from "./_runner";

// --- Routing pre-pass (Commit 4) ---
export {
  classifyIntent,
  IntentClassifierInput,
  type IntentClassifierDeps,
} from "./intent-classifier";
export {
  handleOverride,
  OverrideCategory,
  OverrideHandlerInput,
  OverrideHandlerOutput,
  OverrideMode,
  OverrideScope,
  type OverrideHandlerDeps,
} from "./override-handler";
export {
  routePlayerMessage,
  RouterInput,
  type RouterDeps,
  type RouterVerdict,
} from "./router";
export {
  Canonicality,
  EntityUpdate,
  validateAssertion,
  WorldBuilderDecision,
  WorldBuilderInput,
  WorldBuilderOutput,
  type WorldBuilderDeps,
} from "./world-builder";

// --- Director (arc conductor; called by post-turn workers) ---
export {
  ArcMode,
  ArcPhase,
  DirectorInput,
  DirectorOutput,
  DirectorTrigger,
  renderVoicePatternsJournal,
  runDirector,
} from "./director";

// --- Judgment consultants (Commit 5) ---
export {
  CombatAgentInput,
  CombatAgentOutput,
  CombatResolution,
  CombatStyle,
  resolveCombat,
} from "./combat-agent";
export {
  MemoryRankerInput,
  MemoryRankerOutput,
  rankMemories,
} from "./memory-ranker";
export { judgeOutcome, OutcomeJudgeInput } from "./outcome-judge";
export {
  advisePacing,
  BeatDirective,
  PacingAgentInput,
  PacingAgentOutput,
} from "./pacing-agent";
export {
  produceRecap,
  RecapAgentInput,
  RecapAgentOutput,
} from "./recap-agent";
export {
  CompositionMode,
  ScaleSelectorInput,
  ScaleSelectorOutput,
  selectScale,
} from "./scale-selector-agent";
export {
  judgeOutcomeWithValidation,
  validateOutcome,
  ValidatorInput,
  ValidatorOutput,
} from "./validator";

// --- Shared types ---
export {
  defaultLogger,
  type AgentDeps,
  type AgentLogger,
  type AgentLogLevel,
} from "./types";
