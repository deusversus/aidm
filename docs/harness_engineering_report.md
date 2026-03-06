# Harness Engineering Report
*Generated 2026-03-06 — AIDM project audit against current field best practices*

---

## What AIDM Already Gets Right

These patterns have been independently validated at scale by the broader field. No action needed.

**Deterministic backbone + autonomous islands**
Turn pipeline is a state machine. Session Zero phases, intent classification, meta/gameplay routing — all deterministic. Agents (Director, KA, narrator) have creative autonomy within nodes. This is the CrewAI-documented winning pattern from 2B production workflows.

**Structured output at agent boundaries**
`DirectorOutput`, `TurnResult`, `MetaDirectorResponse`, `SessionZeroResult` — every inter-agent handoff is schema-enforced via Pydantic. This is the correct architecture and most systems don't do it from the start.

**Tiered memory**
Close to the episodic/semantic/procedural split the field has settled on: `MemoryStore` (episodic, campaign-keyed pgvector), `RuleLibrary` (semantic, RAG chunks), campaign bible (procedural arc planning). The vocabulary differs from Letta's formalization but the architecture is analogous.

**Identity-bearing system prompts**
Director and KA have profile DNA and primary prompts that persist across calls. The recent meta conversation fix (injecting interlude context into the *message*, not the *system prompt*) is exactly the "prompt stability" best practice.

---

## Gaps Against Current Best Practice

Issues ranked roughly by effort-to-value ratio. Address one at a time.

---

### Issue 1 — `_in_meta_conversation` is ephemeral state

**Severity:** Medium. Causes a silent session break on server restart mid-meta.

**Problem:**
`_in_meta_conversation` is a flag on the `Orchestrator` instance. If the server restarts during a meta conversation, the flag is lost. The player's next input routes through normal gameplay classification even though `meta_conversation_history` on the session still contains the open conversation.

**Fix:**
Move the flag to the `Session` object (which is persisted to PostgreSQL via `session_store`). Read it from there on orchestrator init; write it back on change.

**Files to touch:**
- `src/core/session.py` — add `in_meta_conversation: bool = False` to `Session`
- `src/core/orchestrator.py` — remove instance flag; read/write via `self.session`
- `src/core/_turn_pipeline.py` — update all reads/writes of `self._in_meta_conversation`

---

### Issue 2 — No circuit breaker on Director tool loops

**Severity:** Medium. Can burn tokens and hang a turn indefinitely.

**Problem:**
The Director has agentic tool-calling for NPC research, foreshadowing checks, spotlight analysis, etc. There is no `max_tool_rounds` cap enforced at the harness level. If a tool times out, returns an error, or produces unexpected results, the Director can retry the same tool call repeatedly. Vercel publicly documented reducing tool count by 80% in their harness specifically to prevent this failure mode.

**Fix:**
Ensure `max_tool_rounds` is set on the Director's agentic call site. Add a graceful degradation path: if the cap is hit, log a warning and proceed with whatever context has been gathered so far (partial context is better than a hung turn).

**Files to touch:**
- `src/agents/director.py` — verify `max_tool_rounds` is passed to `complete_with_tools`; add fallback narrative if cap is hit
- Check `src/llm/provider.py` — confirm `complete_with_tools` enforces the cap rather than silently continuing

---

### Issue 3 — No observability layer

**Severity:** Medium-high. You cannot currently diagnose production failures or drift.

**Problem:**
`logger.info` is everywhere but there is no structured tracing of agent trajectories. When a session produces a bad narrative turn, there's no way to replay the full sequence (intent classified → Director planned → KA researched → narrator generated) with all inputs, outputs, latencies, and costs at each step. You're flying blind on: which agent is slowest, which tool call fails most often, what a "bad scene" input looks like vs. a "good scene" input.

**Recommended tool:** Langfuse (MIT license, self-hostable, framework-agnostic, 19K+ GitHub stars). ~2 hours to integrate.

**What to instrument:**
- One trace per `process_turn` call
- One span per agent call (intent classifier, Director planning, KA research, KA narration, memory write)
- Capture: input tokens, output tokens, latency ms, model used, cost estimate
- Tag traces with: session_id, campaign_id, intent type, turn number, profile_id

**Fix:**
Add Langfuse client init to server startup. Wrap each agent call in a span. The trace data will surface latency outliers, cost per scene type, and failure modes that are currently invisible.

**Files to touch:**
- `src/core/_turn_pipeline.py` — wrap pipeline stages in trace spans
- `src/agents/director.py`, `src/agents/key_animator.py` — instrument agent calls
- `server.py` or app init — Langfuse client initialization

---

### Issue 4 — Context rot is unmanaged

**Severity:** Medium. Degrades quietly; no signal before it becomes a problem.

**Problem:**
Chroma Research (2025) confirmed all frontier models exhibit measurable performance degradation as context grows — even before the window is full. The "lost in the middle" effect, quadratic attention scaling, and RoPE long-term decay all compound. AIDM does session compaction (`compaction_text` parameter) but there's no active monitoring of *when* to compact or *what* is degrading. Long sessions likely produce subtly worse narration in the middle turns without any harness-level signal.

**Fix:**
Track token count at each pipeline stage. Define a "context health" threshold (e.g., >60% of model's effective window). When crossed, trigger proactive compaction *before* the degradation zone, not after. Log token counts per turn so you can see the growth curve.

**Files to touch:**
- `src/core/_turn_pipeline.py` — add token counting; trigger compaction proactively
- `src/core/orchestrator.py` — expose context health metric
- Consider adding a `context_tokens` field to `TurnResult` for observability

---

### Issue 5 — KA has no cross-session style accumulation

**Severity:** Low now, high aspirationally. The KA writes the same way on session 50 as session 2.

**Problem:**
The KA's primary system prompt (vibe keeper template + profile DNA) is static. It doesn't accumulate the stylistic choices, established phrases, character voice nuances, or narrative register that develop over a real campaign. A human author 50 sessions in writes differently than on session 2 — they know the character's rhythms, the established metaphors, the tone that's been set. The KA starts fresh every time.

**Fix:**
Add a "voice journal" to the campaign bible — a growing structured note that the KA writes at end-of-session and reads at session start. Schema:
- Established phrases / motifs for this character
- Prose register that's been set (dense/sparse, lyrical/terse, etc.)
- Recurring imagery or metaphors
- Tone calibration notes from meta conversations

This requires a write path (KA annotates its own style choices at session end) and a read path (injected into KA context block at session open, alongside profile DNA).

**Files to touch:**
- `src/agents/key_animator.py` — add end-of-session style annotation call; inject voice journal at session open
- `src/db/models.py` — add `voice_journal` field to `CampaignBible` or create a new table
- `src/core/orchestrator.py` — trigger style annotation on session close

---

### Issue 6 — Director has no end-of-session memo

**Severity:** Low now, high aspirationally. Pairs with Issue 5.

**Problem:**
The Director re-reads the campaign bible at the start of each session to reconstruct arc planning context. This works but is reactive — the Director has to re-derive its state from raw data every time. Over many sessions, the campaign bible grows and the reconstruction cost (both tokens and reasoning quality) increases.

**Fix:**
Director writes a structured "end-of-session memo" at session close:
- Current arc position and what was planned for next session
- Foreshadowing seeds that are ready for payoff
- NPCs that need spotlight attention
- Any creative decisions made this session that should carry forward

The memo becomes the seed for the next session's Director startup call — injected before the campaign bible read, not instead of it. Over time, the memo *is* the Director's continuity; the bible is the reference archive.

**Files to touch:**
- `src/agents/director.py` — add `write_session_memo()` method
- `src/core/orchestrator.py` — call `write_session_memo()` on session close
- `src/db/models.py` — add `session_memo` field to `CampaignBible` or session record

---

## Aspirational Architecture Notes

These aren't bugs or gaps — they're open research problems that AIDM is bumping into at the frontier of what the field has solved.

**Long-horizon narrative coherence**
The field's longest-running agents operate for hours on focused tasks. Nobody has a reference architecture for a creative agent relationship sustained over 100+ sessions. The "35-minute cliff" research (every agent experiences success rate decrease after ~35 minutes of continuous operation; doubling duration quadruples failure rate) suggests clean session handoff design is critical — each session should start from a durable state artifact, not from in-memory reconstruction.

**Persistent creative identity**
The KA shouldn't just have the same system prompt every session; it should have *accumulated voice*. Letta's Core Memory is the closest field analogue but was designed for factual identity (name, goals, relationships), not aesthetic/stylistic drift. Issue 5 above is the practical implementation of this; the theoretical problem (how does a creative agent develop and maintain a consistent voice over months?) is genuinely unsolved.

**Ensemble creative continuity**
Director + KA + narrator need to feel like they've been collaborating for months, not meeting for the first time each session. Multi-agent coordination patterns exist; multi-agent *creative continuity* patterns don't. Issues 5 and 6 are partial mitigations.

**Meta conversation as first-class narrative mechanic**
The production studio interlude (breaking the fourth wall, speaking with the team, re-entering the story with adjustments integrated) is not a problem the agent framework space is working on. It's a UX and narrative design problem that happens to require AI infrastructure. AIDM is on its own here — there are no reference architectures to steal from.

---

## Field Landscape Quick Reference

For context when evaluating any future tooling decisions:

| Tool | Best For | Avoid If |
|------|----------|----------|
| LangGraph | Stateful multi-step orchestration with checkpointing | You want simplicity; it adds graph complexity |
| LlamaIndex | RAG pipelines, document ingestion | General agent orchestration |
| Pydantic AI | Schema-enforced structured output, full agent runtime | You just need extraction (use Instructor instead) |
| Instructor | Single-call schema extraction with retry | You need a full agent runtime |
| Langfuse | Observability, tracing, eval (self-hostable) | You're locked into LangSmith already |
| Letta | Persistent agent identity across sessions | Stateless/short-lived agents |
| MCP | Tool connectivity (standardized protocol) | Internal-only tools with no ecosystem need |
| CrewAI | Role-based multi-agent composition | You need fine-grained graph control |
| DSPy | Optimizing LLM pipeline prompts automatically | General orchestration |

**Do not use:** OpenAI Assistants API (deprecated August 2026), AutoGen standalone (merging into Microsoft Agent Framework).

---

*Sources: Anthropic engineering blog (harnesses + context engineering), CrewAI 2B workflow report, Chroma Research context rot study, Letta memory architecture docs, LangGraph v1.0 release notes, Langfuse docs, Galileo/Augment multi-agent failure analysis, ICLR 2025 tool hallucination research.*
