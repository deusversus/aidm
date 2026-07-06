import type { SakugaMode } from "@/lib/types/turn";

/**
 * Sakuga fragment texts, carried VERBATIM from v3 via v4's prompt registry
 * (reference/aidm_v4/src/lib/prompts/fragments/sakuga_*.md). Inlined as
 * constants because the fragments must bundle with the turn engine — no fs
 * reads, no standalone-tracing hazards. The text is the salvage; the
 * registry storage shape was plumbing.
 */

const CHOREOGRAPHIC = `## 🎬 SAKUGA MODE ACTIVE — Choreographic

This is a CLIMACTIC action moment. Full animation budget:

### Choreography Over Action
- Don't just say "He punched him"
- Describe the shift in weight, the blur of motion, the shockwave of impact
- Treat the text like a storyboard for an animation

### Sensory Overload
- **Visuals:** Lighting changes, color shifts (auras), speed lines
- **Audio:** The sound of breaking bone, the high-pitch whine of energy charging
- **Physical:** The heat, the wind pressure, the vibration

### Pacing Control
- Use short, punchy sentences for speed
- Use long, flowing sentences for buildup
- Use \`---\` dividers for "impact frame" frozen moments of extreme detail

### No Mechanical Talk
- Never mention HP, damage numbers, or dice
- "Critical Hit" → "A devastating blow that shatters defenses"
- "Miss" → "A hair's breadth dodge, the wind of the attack cutting the cheek"

### Profile Adherence
- Match the power system and visual language of this anime
- Use the DNA scales to calibrate the intensity
`;

const FROZEN_MOMENT = `## 🎬 SAKUGA MODE ACTIVE — Frozen Moment

This is a CLIMACTIC emotional moment. Time dilates:

### Time Dilation
- One second, one heartbeat, one decision — stretched across the scene
- Internal monologue dominates. The character THINKS before the world moves
- Sound drops out. Then one detail floods back in — a drip, a breath, a word

### Interiority Over Action
- The external action is secondary. What matters is what this MEANS
- Memory fragments surface unbidden — flashes of why this matters
- The body reacts before the mind catches up: trembling hands, held breath

### Emotional Architecture
- Build in layers: physical sensation → memory → realization → decision
- Let silence carry weight. Not every moment needs words
- The world waits for the character. Then it all crashes back

### Restraint
- No exposition. The reader should FEEL it, not be told about it
- Dialogue is minimal — a single word can be enough
- Match the profile's emotional register, not generic drama
`;

const AFTERMATH = `## 🎬 SAKUGA MODE ACTIVE — Aftermath

The climax just happened. Now: the silence after the explosion.

### Quiet Devastation
- The action is over. What's LEFT? Describe damage, wreckage, changed landscape
- Sound returns slowly — ringing ears, settling dust, dripping water
- Characters take stock: injuries, losses, what just changed forever

### Environmental Focus
- The WORLD tells the story of what happened. Cracked walls, scorched earth, shifted light
- Small details carry enormous weight: a cracked photograph, a single shoe, smoke rising
- The camera pulls back — show the scale of what occurred

### Emotional Exhaustion
- Characters are spent. Adrenaline crash. Numbness before the grief hits
- Dialogue is sparse, practical. "Can you walk?" Not speeches
- This is where consequences become REAL. Don't rush past the cost

### Bridge Forward
- Plant one seed of what comes next — a distant sound, a new arrival, a realization
- End on an image, not a statement
`;

const MONTAGE = `## 🎬 SAKUGA MODE ACTIVE — Montage

Time compresses. Multiple scenes, one momentum:

### Quick Cuts
- Sentence fragments. Scene changes mid-paragraph
- \`---\` dividers between moments — each one a snapshot
- Dawn. Training. Noon. Failure. Dusk. Breakthrough. Night. Rest

### Show Progress
- Each cut shows change — improvement, deterioration, accumulation
- Repetition with variation: the same action, done differently each time
- Small victories stack. The montage ends differently than it began

### Sensory Snapshots
- Each beat gets ONE dominant sense — sweat, the sound of impact, the smell of rain
- No lingering. Quick impressions that imprint and move on
- The rhythm matters more than the detail

### Emotional Undercurrent
- Beneath the activity: determination, obsession, fear of failure
- One quiet moment in the middle — the character alone, the reason WHY
- End with arrival: they're ready. Or they think they are
`;

export const SAKUGA_FRAGMENTS: Record<SakugaMode, string> = {
  choreographic: CHOREOGRAPHIC,
  frozen_moment: FROZEN_MOMENT,
  aftermath: AFTERMATH,
  montage: MONTAGE,
};
