import { env } from "@/lib/env";
import { GoogleGenAI } from "@google/genai";

let _client: GoogleGenAI | undefined;

export function getGoogle(): GoogleGenAI {
  if (_client) return _client;
  const apiKey = env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not configured");
  _client = new GoogleGenAI({ apiKey });
  return _client;
}
