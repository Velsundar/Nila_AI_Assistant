/** Server-side speech-to-text via Groq Whisper (OpenAI-compatible /audio/transcriptions). */
import { config } from "../config";
import { HttpError } from "../errors";
import { rateLimitWaitMs } from "../agent/llm";
import { decodeDataUrl } from "./receipts";

export const MAX_AUDIO_BYTES = 10.5 * 1024 * 1024;
const GROQ_BASE = "https://api.groq.com/openai/v1";

/** Whisper picks the decoder from the file extension, so map the MIME type to one it accepts. */
export function audioExtension(mime: string): string {
  const sub = mime.split("/")[1] ?? "";
  if (/webm/.test(sub)) return "webm";
  if (/(m4a|mp4|aac|x-m4a|quicktime)/.test(sub)) return "m4a";
  if (/(mpeg|mp3|mpga)/.test(sub)) return "mp3";
  if (/wav|wave/.test(sub)) return "wav";
  if (/ogg|opus/.test(sub)) return "ogg";
  if (/flac/.test(sub)) return "flac";
  return "webm";
}

export function sttConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  const { provider, apiKey, baseUrl, sttModel } = config.llm;
  // Only Groq hosts Whisper among the free providers we support.
  if (provider !== "groq" || !apiKey) return null;
  return { baseUrl: (baseUrl ?? GROQ_BASE).replace(/\/+$/, ""), apiKey, model: sttModel };
}

export async function transcribe(
  dataUrl: string,
  language: string | undefined,
  opts: { fetchImpl?: typeof fetch; stt?: ReturnType<typeof sttConfig>; consumeBudget?: () => Promise<void> } = {},
): Promise<{ text: string }> {
  const stt = opts.stt === undefined ? sttConfig() : opts.stt;
  if (!stt) throw new HttpError(503, "STT_UNAVAILABLE", "Server speech-to-text needs a Groq API key");
  const { mime, bytes } = decodeDataUrl(dataUrl, "audio");
  if (bytes.length > MAX_AUDIO_BYTES) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Audio is larger than 10 MB");

  await opts.consumeBudget?.();
  const ext = audioExtension(mime);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), `audio.${ext}`);
  form.append("model", stt.model);
  form.append("response_format", "json");
  form.append("temperature", "0");
  if (language) form.append("language", language.slice(0, 2).toLowerCase());
  // Bias towards Indian-English money talk ("two hundred" -> ₹200, not $200).
  form.append("prompt", "Expense and to-do notes in Indian English. Amounts are in rupees, e.g. spent 250 rupees on lunch at Swiggy.");

  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(`${stt.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${stt.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new HttpError(502, "STT_FAILED", `Speech service unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429) {
      const wait = rateLimitWaitMs(res.headers, body);
      throw new HttpError(429, "STT_RATE_LIMITED", "Speech service is busy, try again shortly", wait !== undefined ? { retryAfterMs: wait } : undefined);
    }
    if (res.status === 400) throw new HttpError(400, "STT_BAD_AUDIO", "Could not decode that audio");
    throw new HttpError(502, "STT_FAILED", `Speech service error ${res.status}`);
  }
  const data = (await res.json().catch(() => ({}))) as { text?: string };
  return { text: (data.text ?? "").trim() };
}
