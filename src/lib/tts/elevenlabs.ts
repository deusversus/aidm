import { env } from "@/lib/env";

/**
 * ElevenLabs synthesis — the voice half of §9.5's media exception (the
 * second sanctioned non-Anthropic provider family; story generation is
 * untouched). Server-only: the key never reaches a client. Billing is
 * ElevenLabs subscription credits (per character), fully separate from the
 * Anthropic ledger — usage is recorded in model_calls as character counts
 * with costUsd 0 (see the route).
 */

export function ttsConfigured(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

export async function synthesize(text: string): Promise<Response> {
  const key = env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY not configured");
  const voice = env.ELEVENLABS_VOICE_ID;
  const model = env.ELEVENLABS_MODEL_ID;
  // optimize_streaming_latency=3: every latency optimization that costs no
  // quality — the first audio chunk arrives in seconds instead of after the
  // whole scene renders; the element plays progressively from there.
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream?optimize_streaming_latency=3`,
    {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  );
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`elevenlabs ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res;
}
