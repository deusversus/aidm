import { env } from "@/lib/env";

/**
 * ElevenLabs synthesis — the voice half of §9.5's media exception (the
 * second sanctioned non-Anthropic provider family; story generation is
 * untouched). Server-only: the key never reaches a client. Billing is
 * ElevenLabs usage credits (per character), fully separate from the
 * Anthropic ledger — usage is recorded in model_calls as character counts
 * with costUsd 0 (see the route).
 */

export function ttsConfigured(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

export interface VoiceOption {
  voice_id: string;
  name: string;
  /** Short human hint assembled from ElevenLabs labels (accent, age, vibe). */
  hint: string;
}

/**
 * Curated premade fallback: shown when the key lacks `voices_read` (the
 * current scoping). Once the key gains that permission, the player's OWN
 * library — including any anime-style community voices they add in the
 * ElevenLabs UI — replaces this list automatically.
 */
export const CURATED_VOICES: VoiceOption[] = [
  { voice_id: "JBFqnCBsd6RMkjVDRZzb", name: "George", hint: "warm British narrator (the default)" },
  { voice_id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel", hint: "calm American, even-keeled" },
  { voice_id: "AZnzlk1XvdvUeBnXmlld", name: "Domi", hint: "young, strong-willed, bright" },
  { voice_id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli", hint: "young, emotive, light" },
  { voice_id: "ErXwobaYiN019PkySvjV", name: "Antoni", hint: "well-rounded, softer edge" },
  { voice_id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh", hint: "deep, serious, cinematic" },
];

/** The fixed preview line — the ONLY text the preview mode may speak (the
 *  no-open-proxy invariant holds: clients never supply text). */
export const PREVIEW_LINE =
  "The rain let up just before dawn. Somewhere over the rooftops, the story was already moving.";

/**
 * The player's voice library, when the key permits (`voices_read`); null
 * when it does not — callers fall back to CURATED_VOICES.
 */
export async function listVoices(): Promise<VoiceOption[] | null> {
  const key = env.ELEVENLABS_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": key },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      voices?: { voice_id: string; name: string; labels?: Record<string, string> }[];
    };
    if (!data.voices) return null;
    return data.voices.map((v) => ({
      voice_id: v.voice_id,
      name: v.name,
      hint: Object.values(v.labels ?? {})
        .filter(Boolean)
        .join(", "),
    }));
  } catch {
    return null;
  }
}

/** Library when permitted, curated otherwise — the settings menu's options. */
export async function availableVoices(): Promise<{
  voices: VoiceOption[];
  source: "library" | "curated";
}> {
  const library = await listVoices();
  if (library && library.length > 0) return { voices: library, source: "library" };
  return { voices: CURATED_VOICES, source: "curated" };
}

export async function synthesize(text: string, voiceId?: string): Promise<Response> {
  const key = env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY not configured");
  const voice = voiceId || env.ELEVENLABS_VOICE_ID;
  const model = env.ELEVENLABS_MODEL_ID;
  // optimize_streaming_latency=3: every latency optimization that costs no
  // quality — first audio in ~2.5s measured (2026-07-19) while the rest of
  // the scene synthesizes behind the playhead.
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
