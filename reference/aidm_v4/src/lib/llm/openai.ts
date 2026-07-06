import { env } from "@/lib/env";
import OpenAI from "openai";

/**
 * The OpenAI client does double duty: direct OpenAI calls AND OpenRouter
 * (swap baseURL, use OPENROUTER_API_KEY). M1+ adds a second factory when
 * OpenRouter becomes load-bearing. At M0 we just make sure the SDK wires up.
 */
let _client: OpenAI | undefined;

export function getOpenAI(): OpenAI {
  if (_client) return _client;
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
  _client = new OpenAI({ apiKey });
  return _client;
}
