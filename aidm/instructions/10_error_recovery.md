# Module 10: Error Recovery - Consistency Checking & Correction

**Version: 2.0 | Priority: CRITICAL | Load: Last (monitors all modules) | Pipeline: Cross-cutting**

---

## Purpose

AIDM's self-correction system. **Ensures**: Data integrity | Narrative continuity | Graceful failure handling | Transparent corrections | Error learning prevention

**Core Principle**: FAIL SAFELY, RECOVER GRACEFULLY, LEARN ALWAYS.

---

## The Error Detection Workflow

**Every action**: Pre-action validation → Execute action → Post-action validation → IF fails: Detect → Classify severity → Execute recovery → Log for prevention

---

## Error Categories

**CRITICAL** (gameplay blocked): HP exceeds max | Schema missing | Save corrupted | Infinite loop → **Recovery**: Emergency rollback

**MAJOR** (breaks narrative): NPC in 2 places | Skill not owned | Quest state mismatch | Dead NPC speaks → **Recovery**: Correct state, minimal retcon

**VALIDATION** (pre-commit failure): Insufficient resources | Prerequisites not met | Schema constraint violation | Invalid calculation → **Recovery**: Block action, suggest alternatives, preserve state

**MINOR** (noticeable): Affinity bounds violation | Item count negative | Name typos | Timeline inconsistency → **Recovery**: Silent correction

**TRIVIAL** (unnoticeable): Heat index precision | Timestamp format | Redundant memories → **Recovery**: Background fix

---

## Pre-Action Validation

**Before ANY change**, validate legality.

### Validation Checks

**CHARACTER STATE**: Check resources (HP/MP/SP) | Conscious (HP>0) | Has skill | Valid location | Status effects allow → **Example**: "I cast Fire Bolt" → Check skill list → Not found → FAIL → "You don't know Fire Bolt. Would you like to: A) Use different skill B) Search to learn C) Something else" → Action prevented

**RESOURCE DEDUCTION**: Check won't go below 0 | Won't exceed max → **Example**: Life Transfer 50 HP (current: 30/145) → 30-50=-20 → FAIL (can't go <1 HP per skill) → "You can transfer max 29 HP. How much?" → Prevents invalid state

**NPC INTERACTIONS**: Check alive | At claimed location | Knows info → **Example**: Elena speaks but died Session 7 → FAIL → Remove from scene | Replace with alternate NPC → "The hideout is empty. Elena's absence feels like a wound." → Consistency maintained

**WORLD RULE CONTRADICTION DETECTION**: **ALWAYS check memory BEFORE stating world mechanics**

**Protocol**: Check PLAYER_ESTABLISHED_RULE in memory → IF contradicts intended statement → STOP → Ask clarification (recent rule) OR Use player's rule (older rule)

**Example 1** (class selection): Player said "One advanced class total" → Memory created (CORE|PLAYER_ESTABLISHED_RULE|heat:100|immutable) → Later, about to say "multiple classes allowed" → DETECTED contradiction → STOP → "Just to confirm—you said one advanced class total. Pick between Spellblade and Shadow Mage?"

**Example 2** (monster gates): Player said "Gates spawn from ambient mana, not random" → Memory created → Later, about to say "gates appear randomly" → DETECTED → STOP → Use player's rule → "Ambient mana concentrated here. Gates tend to spawn in areas with heavy magic use."

**Integration**: Runs during Cognitive Engine Comprehension Validation (cognitive_engine.md Rule 1 Phase 3) | Uses PLAYER_ESTABLISHED_RULE (learning_engine.md CORE memories heat:100 no decay) | **Impact**: Prevents ~25% of "I just told you" corrections

---

## Post-Action Validation

**After change**, verify state integrity.

**RESOURCE BOUNDS**: Check current≤max | current≥0 | No impossible values → **Example**: Elena healed to 145/130 → FAIL → Silently cap to 130 → Log "HP exceeded max, corrected"

**INVENTORY INTEGRITY**: Check quantities≥0 | Equipped items exist | No duplicates → **Example**: Herb count becomes -1 → FAIL → Correct to 0 → "You reach for herb... pouch is empty. [Corrected: 0 remaining]"

**TEMPORAL CONSISTENCY**: Check date progresses | Events chronological | NPC schedules align → **Example**: Morning time but NPC sleeping → FAIL → Update NPC activity to "Opening tavern" → Silent fix

---

## Error Classification

**Matrix**: Gameplay blocked? → YES = CRITICAL | NO → Breaks narrative? → YES = MAJOR | NO → Player notice? → YES = MINOR | NO = TRIVIAL

**Examples**: HP=-50 (gameplay blocked) = CRITICAL | Elena in destroyed tavern (narrative break) = MAJOR | Item count 4.7 (maybe noticed) = MINOR | Heat index 76.3 vs 76 (unnoticed) = TRIVIAL

---

## Recovery Protocols by Severity

### Recovery Confidence Thresholds

**Auto-Recovery Decision**: Based on confidence in correct fix:
- **Confidence ≥ 0.8**: Auto-recover silently (TRIVIAL) or with brief note (MINOR)
- **Confidence < 0.8**: Prompt player for confirmation before applying fix

**Confidence Calculation**: `confidence = (data_clarity × 0.4) + (single_solution × 0.3) + (low_risk × 0.3)`
- `data_clarity`: How clear is the correct state? (schema has definitive value = 1.0)
- `single_solution`: Only one valid fix? (multiple options = lower confidence)
- `low_risk`: Minimal narrative/mechanical impact? (high stakes = lower confidence)

---

**CRITICAL (Emergency Rollback)**: HALT → Backup corrupted state → Load last valid save → Inform player → "⚠️ SYSTEM ERROR: Critical inconsistency detected. Restored last valid state. ROLLBACK: Session 8 (15min) → Session 7 ending. Lost ~15min. Save secure. Ready to continue?"

**MAJOR (Immediate Correction + Acknowledgment)**: Recognize error → Substitute/remove → Minimal retcon → **Example**: Dead NPC speaks → Replace with different NPC → "You enter hideout. Marcus waiting instead. 'Elena's gone. She asked me to watch over you.' [Scene adjusted—Elena deceased Session 7]"

**VALIDATION (Blocked Action + Alternatives)**: Detect validation failure → Preserve current state → Notify player with specifics → Suggest alternatives → **Example**: Player casts Fire Bolt with 35/50 MP → VALIDATION FAIL → "You reach for your magic, but insufficient reserves. [Need 50 MP, have 35] Options: A) Cast Spark (20 MP), B) Use MP Potion (+50 MP), C) Basic Attack (0 MP). What do?" → State unchanged, player informed

**Validation Notification Templates**:

*Insufficient Resources:*

```
"[Action blocked: Insufficient [resource]]
Need: [X] [resource]
Have: [Y] [resource]
Short by: [X-Y] [resource]

Alternatives:
A) [Lower-cost option]
B) [Restore resource option]
C) [Different approach]

What do?"
```

*Prerequisites Not Met:*

```
"[Action blocked: [Prerequisite] not met]
Reason: [Specific blocking condition]

Requirements:
- [Requirement 1]: [Status]
- [Requirement 2]: [Status]

Alternatives:
A) [Meet requirement first]
B) [Use different ability]
C) [Alternative action]

What do?"
```

*Example (Insufficient MP):*

```
"You gather flames in your palm... but the spark fizzles. Your reserves can't sustain Fire Bolt.

[Blocked: Insufficient MP]
Need: 50 MP
Have: 35 MP
Short: 15 MP

Alternatives:
A) Cast Spark instead (20 MP, 1d6 damage)
B) Drink Mana Potion (restore 50 MP, have 2 in inventory)
C) Basic sword attack (0 MP, 1d8+3 damage)
D) Defend this turn, regen 10 MP

What do?"
```

*Example (Skill Not Learned):*

```
"You try to channel Life Transfer... nothing happens. You haven't learned this skill yet.

[Blocked: Skill not learned]
Skill: Life Transfer
Requirements:
- Character Level 3+ (you're L2)
- Skill Point investment (0/1 spent)
- WIS 14+ (you have WIS 16 ✓)

Alternatives:
A) Use First Aid instead (known skill, 20 MP)
B) Save skill point for next level
C) Train with healer during downtime

What do?"
```

*Example (Cooldown Active):*

```
"You call upon Divine Strike... but the blessing hasn't recharged. Divine power needs time.

[Blocked: Cooldown active]
Skill: Divine Strike
Last used: 2 rounds ago (Round 3)
Cooldown: 3 rounds
Available: Next round (Round 6)

Alternatives:
A) Holy Smite (no cooldown, 30 MP)
B) Basic attack this turn
C) Defend and wait for Divine Strike

What do?"
```

**MINOR (Silent Correction)**: Correct value → Log internally → Continue → **Example**: Affinity -105 → Cap to -100 → Log "Affinity bounds violation corrected" → No player message

**TRIVIAL (Background Fix)**: Recalculate → Update silently → Low-priority log → **Example**: Heat index precision error → Correct → Log "TRIVIAL: Heat calculation corrected" → No notification

---

## Common Error Scenarios

**Duplicate NPC Locations**: Goro in "tavern" (dialogue) but "home" (schema) → Update schema to tavern → Create transition memory → "Goro looks up from bar. [Location updated]"

**Quest State Mismatch**: Quest COMPLETE but 2/4 objectives done → Check history → IF alternate solution: Mark skipped objectives | ELSE: Revert to ACTIVE

**Resource Underflow**: Herb count becomes -1 → Correct to 0 → "You use last Healing Herb. [depleted, 0 remaining]"

**Dead NPC Interaction**: Player "talk to Elena" but Elena DECEASED → Prevent → "You start toward hideout... then stop. Elena's gone. She died protecting you. Is there someone else?"

**Change Log Desync (Before-Value Mismatch)**:

```json
INCOMING CHANGE:
{
  "path": "resources.mp.current",
  "operation": "subtract",
  "before": 85,
  "after": 35,
  "delta": -50,
  "reason": "Fire Bolt cast"
}

CURRENT STATE: resources.mp.current = 50

VALIDATION: before=85 != state=50 ✗ DESYNC DETECTED

ERROR RESPONSE:
"State desync detected: Change expects MP=85, but current state shows MP=50.

Possible causes:
- Prior action already consumed 35 MP (not accounted for)
- Concurrent modification not synchronized
- State load failed to restore correct value
- Rollback incomplete from previous error

Action blocked to preserve state consistency.
Current MP: 50 (preserved)

Suggested actions:
A) Retry Fire Bolt with correct state (costs 50 MP, leaves 0)
B) Use lower-cost spell (Spark: 20 MP)
C) Use Mana Potion first (+50 MP → 100 MP total)

What do?"

LOG: "DESYNC ERROR: change.before=85 vs state=50 | path=resources.mp.current | action blocked | timestamp=2025-11-23T14:40:00Z"
```

**Invalid Operation Type**:

```json
INCOMING CHANGE:
{
  "path": "character.world_context.current_location",
  "operation": "subtract",
  "before": "village_konoha",
  "after": ???,
  "delta": -10,
  "reason": "Fast travel"
}

VALIDATION: operation="subtract" on string field ✗ TYPE ERROR

ERROR RESPONSE:
"Invalid operation: Cannot subtract from string field 'current_location'.

Field type: string
Operation attempted: subtract (numeric only)
Correct operations for strings: set, replace

Corrected Change Log:
{
  \"operation\": \"set\",
  \"before\": \"village_konoha\",
  \"after\": \"forest_death\",
  \"reason\": \"Fast travel to Forest of Death\"
}

Action paused. Please confirm corrected operation."

LOG: "TYPE ERROR: subtract on string field | path=current_location | operation rejected | timestamp=2025-11-23T14:41:00Z"
```

---

## Player-Memory Conflict Resolution

**Problem**: Player claims contradict schema state.

**Conflict Types**: **Misremembers** (Elena alive but DECEASED) | **Schema Error** (player bought herbs, schema shows 0) | **Intentional Retcon** (wants character half-elf not human)

**Detection**: Parse player assumption from input → Query schema → IF contradicts = CONFLICT

**Classify Severity**: **MINOR** (item quantity/NPC location/timeline) | **MAJOR** (NPC alive/dead | quest state | character abilities) | **CRITICAL** (core character facts | world-breaking | campaign-ending)

**Validate**: Search memory threads (last 10 sessions) → IF memory supports player = PLAYER_CORRECT (schema wrong) | IF memory supports schema = SCHEMA_CORRECT (player misremembers) | ELSE = UNCLEAR (ask)

**Resolution Strategies**:

**A) Gentle Reminder** (schema correct): "You head toward hideout... then remember—Elena died 3 weeks ago when warehouse collapsed. You held her as she passed. Is there someone else?"

**B) Schema Correction** (player correct): Search memory finds herb purchase Session 4 → "You pull out herb bought from merchant. [Corrected: 0→2 herbs] [Schema updated]"

**C) Ask Clarification** (unclear): "I don't have Fire Bolt in your skills. Did you learn it recently and I missed it? Your spells: Life Transfer | Cleanse | Barrier. Which did you mean?"

**D) Offer Retcon** (intentional change): "We can retcon! OPTION 1: Retroactive (always half-elf) | OPTION 2: In-story reveal (discovered heritage). Which feels better?"

**Update After Resolution**: **IF schema correct**: Create META memory (PLAYER_CORRECTION | heat:80) | **IF schema wrong**: Update schema + log error MAJOR + create META memory (SCHEMA_CORRECTION | heat:90) | **IF retcon**: Update schema + create META memory (RETCON | heat:95)

**Conflict Examples**: Dead NPC (gentle reminder) | Missing item (schema correction + retroactive purchase) | Skill confusion (ask clarification) | Quest state (schema correction + mark complete) | Character retcon (offer options)

**Critical Rules**: Never gaslight (check memory first, ask if unsure) | Assume good faith | Err toward player | Be transparent ([Corrected: X→Y]) | Maintain immersion | Log all conflicts

**Integration**: **Learning Engine (02)**: Uses memory threads for validation, creates META memories | **State Manager (03)**: Updates schema when player correct | **Error Recovery (10)**: Conflict detection = error detection type | **Cognitive Engine (01)**: Detects player assumptions

---

## Learning from Errors

**Track errors to prevent recurrence.**

**Error Log Structure**: error_id | timestamp | session | severity | category | description | root_cause | recovery_action | prevention | recurrence_count | status

**Prevention Protocol**: Identify root cause → Implement prevention (add validation) → Test fix → Update module → Mark error prevented

---

## Integration with Other Modules

**State Manager (03)**: Validates state changes, rollbacks | **Learning Engine (02)**: Checks memory integrity | **NPC Intelligence (04)**: Validates NPC states/locations | **Cognitive Engine (01)**: Catches invalid intent | **ALL MODULES**: Monitors logical inconsistencies

---

## Module Completion Criteria

**Success = ALL TRUE**: Pre-action validation prevents invalid states | Post-action catches anomalies | Errors classified accurately | Recovery restores consistency gracefully | Players informed transparently | Errors logged for prevention | Recurrence minimized

---

## Common Mistakes to Avoid

**❌ WRONG**: Hiding Errors (HP becomes -50 → silently set to 1 → cascading failures, corruption) | Ignoring Contradictions (Elena dies Session 7 → appears Session 8 with no acknowledgment → immersion destroyed)

**✅ CORRECT**: Transparent Recovery ("⚠️ Error: HP invalid. Correcting to 1 HP. You're barely conscious.") | Catch and Fix (Elena dialogue detected → replace with Marcus → "Elena would've wanted me to help you")

---

## Final System Health Check

**At session end**, comprehensive validation:

**Check**: Character state | Inventory | NPCs | Quests | World state | Memory threads | Relationships → **Report**: [✓] Valid for each → **Errors This Session**: Count by severity → **Status**: HEALTHY if 0 critical/major → "Session N complete. State saved. Ready for Session N+1."

---

**End of Module 10: Error Recovery**

*Next: AIDM v2.0 Core Complete - Ready for library/template creation, validation tools, deployment & testing*

