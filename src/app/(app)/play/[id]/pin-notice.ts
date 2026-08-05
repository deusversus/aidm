import { PIN_MAX_COUNT, PIN_MAX_TOKENS } from "@/lib/blocks/assemble";

/**
 * The pin notice (§5.4, pure half — no JSX, so it unit-tests without a DOM).
 *
 * `assembleBlocks` has always known which pins the head of memory can actually
 * carry, and the surface used to say "Pinned — held verbatim at the head of
 * memory" either way. The POST now answers with the truth, and this composes
 * the one-line notice from it.
 *
 * The two drop conditions are independent, so there are FOUR sentences, not
 * three (M3R3 close): a pin can be withheld because its source scene is still
 * quoted in full AND have nowhere to land once that scene compacts. Saying
 * only the first is the optimistic half of a two-part answer — precisely the
 * case the wire exists to fix.
 */

export interface PinPostResponse {
  carried?: boolean;
  reason?: "in_window" | "budget";
  /** The head has no room for this pin even once the window releases it. */
  wouldExceedBudget?: boolean;
  /** What the head is carrying right now (pins kept, approx tokens). */
  head?: { count: number; tokens: number };
  limits?: { maxCount: number; maxTokens: number };
}

/** "5 of 5 passages" / "about 1,900 of 2,000 tokens" — whichever bound binds. */
function capacity(body: PinPostResponse): string {
  const maxCount = body.limits?.maxCount ?? PIN_MAX_COUNT;
  const maxTokens = body.limits?.maxTokens ?? PIN_MAX_TOKENS;
  const count = body.head?.count ?? maxCount;
  const tokens = body.head?.tokens ?? maxTokens;
  return count >= maxCount
    ? `${count} of ${maxCount} passages`
    : `about ${tokens} of ${maxTokens} tokens`;
}

export function pinNoticeText(body: PinPostResponse | null): string {
  if (!body) return "Pin failed.";
  if (body.carried !== false) return "Pinned — held verbatim at the head of memory.";
  if (body.reason === "in_window") {
    const later =
      "Pinned — the scene it came from is still quoted in full, so it joins the head of memory once that scene compacts.";
    // The honest second half: eligibility is not room.
    return body.wouldExceedBudget
      ? `${later} Note: the head is at capacity (${capacity(body)}) — it will need room when it becomes eligible.`
      : later;
  }
  return `Pinned, but NOT carried: the head of memory holds ${body.limits?.maxCount ?? PIN_MAX_COUNT} passages (about ${body.limits?.maxTokens ?? PIN_MAX_TOKENS} tokens). Remove one in the notes panel to make room.`;
}
