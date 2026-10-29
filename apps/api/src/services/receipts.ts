/**
 * Receipt scanning. Order of attempts:
 *   1. A vision-capable LLM (Groq qwen/qwen3.8-27b by default) reads the image and returns JSON.
 *   2. Otherwise / on failure: tesseract.js OCR (free, local) -> regex parser.
 * Never saves anything; the client shows the draft for confirmation.
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { Category, ReceiptScanResult } from "@nova/shared";
import { CATEGORIES } from "@nova/shared";
import { config } from "../config";
import { HttpError } from "../errors";
import { PROVIDER_DEFAULTS, rateLimitWaitMs, stripThinking } from "../agent/llm";
import { categoryFromText } from "../agent/mock";
import { normalizeCategory } from "../agent/tools";
import { addDays, localDateString } from "./dates";

export const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

type Draft = ReceiptScanResult["draft"];

/** Decode "data:<mime>[;params];base64,<data>". */
export function decodeDataUrl(dataUrl: string, kind: "image" | "audio"): { mime: string; bytes: Buffer } {
  const m = /^data:([a-z]+\/[a-z0-9.+-]+)((?:;[a-z0-9-]+=[^;,]*)*);base64,([\s\S]*)$/i.exec(dataUrl);
  if (!m || !m[1].toLowerCase().startsWith(`${kind}/`)) {
    throw new HttpError(400, "VALIDATION_ERROR", `Expected a base64 ${kind} data URL`);
  }
  const bytes = Buffer.from(m[3].replace(/\s+/g, ""), "base64");
  if (!bytes.length) throw new HttpError(400, "VALIDATION_ERROR", `Empty ${kind}`);
  return { mime: m[1].toLowerCase(), bytes };
}

// ---------- OCR (tesseract.js), lazily loaded ----------

export type OcrFn = (image: Buffer) => Promise<string>;
let ocrOverride: OcrFn | undefined;
/** Tests inject a fake OCR so nothing is downloaded. */
export function setReceiptOcr(fn: OcrFn | undefined) {
  ocrOverride = fn;
}

const tesseractOcr: OcrFn = async (image) => {
  const { createWorker } = await import("tesseract.js");
  // Language data is fetched once from the tesseract CDN, then cached under .data/.
  const cachePath = path.resolve(process.cwd(), ".data/tesseract");
  await mkdir(cachePath, { recursive: true }).catch(() => {});
  const worker = await createWorker("eng", 1, { cachePath });
  try {
    const { data } = await worker.recognize(image);
    return data.text ?? "";
  } finally {
    await worker.terminate();
  }
};

// ---------- text parsing (OCR output) ----------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

function validYmd(y: number, m: number, d: number): string | undefined {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return undefined;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Accept only plausible receipt dates: within 2 years back, at most 1 day ahead. */
function plausibleDate(ymd: string | undefined, today: string): string | undefined {
  if (!ymd) return undefined;
  if (ymd > addDays(today, 1) || ymd < addDays(today, -730)) return undefined;
  return ymd;
}

export function parseReceiptDate(text: string, today: string): string | undefined {
  const iso = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(text);
  if (iso) return plausibleDate(validYmd(+iso[1], +iso[2], +iso[3]), today);
  // Indian receipts: DD/MM/YYYY (or DD-MM-YY).
  const dmy = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(text);
  if (dmy) return plausibleDate(validYmd(+dmy[3], +dmy[2], +dmy[1]), today);
  const named = /\b(\d{1,2})[\s-]*([a-z]{3})[a-z]*[\s,-]*(\d{2,4})\b/i.exec(text);
  if (named) {
    const mi = MONTHS.indexOf(named[2].toLowerCase());
    if (mi >= 0) return plausibleDate(validYmd(+named[3], mi + 1, +named[1]), today);
  }
  return undefined;
}

const num = (s: string) => Number(s.replace(/,/g, ""));
const AMOUNT_RE = /(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d+)/g;

export function parseReceiptText(text: string, today: string): { draft: Draft; confidence: ReceiptScanResult["confidence"] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const draft: Draft = {};

  // Amount: the "grand total" / "total" / "amount payable" line, never "subtotal".
  const totalLines = lines.filter((l) => /(grand\s*total|net\s*(amount|payable)|amount\s*(due|payable|paid)|total|to\s*pay)/i.test(l) && !/sub\s*-?\s*total/i.test(l));
  const preferred = totalLines.find((l) => /grand|net|payable|due|paid/i.test(l)) ?? totalLines[totalLines.length - 1];
  const amountFrom = (l: string) => {
    const nums = (l.match(AMOUNT_RE) ?? []).map(num).filter((n) => n > 0 && n < 10_000_000);
    return nums.length ? nums[nums.length - 1] : undefined;
  };
  draft.amount = preferred ? amountFrom(preferred) : undefined;
  if (draft.amount === undefined) {
    const all = lines.flatMap((l) => (/\d{1,2}[/:-]\d{1,2}|gstin|phone|ph[:.]|bill no|invoice no/i.test(l) ? [] : (l.match(/\d+\.\d{2}\b/g) ?? []).map(num)));
    if (all.length) draft.amount = Math.max(...all);
  }

  // Merchant: first line that looks like a name.
  const merchant = lines.find(
    (l) =>
      /[a-z]{3}/i.test(l) &&
      (l.match(/\d/g) ?? []).length <= 2 &&
      l.length <= 40 &&
      !/tax invoice|invoice|receipt|bill|gstin|welcome|date|time|cash memo|original|duplicate/i.test(l),
  );
  if (merchant) draft.merchant = merchant.replace(/[^\p{L}\p{N}&'.\- ]/gu, "").replace(/\s+/g, " ").trim().replace(/\b(\w)(\w*)/g, (_, a: string, b: string) => a + b.toLowerCase()).replace(/\b\w/g, (c) => c.toUpperCase());

  draft.date = parseReceiptDate(text, today);
  // Ignore receipt boilerplate ("Bill No", "Tax invoice") so it doesn't read as the Bills category.
  const body = text.replace(/\b(bill|invoice|receipt|cash memo)\b(\s*(no|number|#)\b)?/gi, " ");
  const cat = (draft.merchant && categoryFromText(draft.merchant)) || categoryFromText(body);
  if (cat) draft.category = cat;

  for (const k of Object.keys(draft) as (keyof Draft)[]) if (draft[k] === undefined || draft[k] === "") delete draft[k];
  const confidence = draft.amount && draft.merchant && draft.date ? "medium" : "low";
  return { draft, confidence };
}

// ---------- vision LLM ----------

export function visionConfig(): { baseUrl: string; apiKey: string; model: string } | null {
  const { provider, apiKey, baseUrl, visionModel } = config.llm;
  if (provider === "mock" || !apiKey) return null;
  const model = visionModel ?? PROVIDER_DEFAULTS[provider].visionModel;
  if (!model) return null;
  return { baseUrl: (baseUrl ?? PROVIDER_DEFAULTS[provider].baseUrl).replace(/\/+$/, ""), apiKey, model };
}

function visionPrompt(today: string): string {
  return [
    "Read this receipt or bill and reply with JSON only:",
    `{"amount": number (final total paid, after tax), "merchant": string, "date": "YYYY-MM-DD", "category": one of ${CATEGORIES.join("|")}, "note": short 1-3 word description like "lunch" or "groceries"}.`,
    `Use null for anything you cannot read. Indian receipts usually write dates as DD/MM/YYYY. Today is ${today}.`,
    'If the image is not a receipt, reply {"amount": null}.',
  ].join("\n");
}

/** Pull the first JSON object out of a model reply. */
export function extractJson(s: string | null | undefined): Record<string, unknown> | null {
  if (!s) return null;
  const clean = stripThinking(s) ?? "";
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(clean.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function normalizeDraft(raw: Record<string, unknown>, today: string): Draft {
  const d: Draft = {};
  const amount = typeof raw.amount === "string" ? num(raw.amount.replace(/[^\d.,]/g, "")) : raw.amount;
  if (typeof amount === "number" && Number.isFinite(amount) && amount > 0 && amount < 100_000_000) d.amount = Math.round(amount * 100) / 100;
  if (typeof raw.merchant === "string" && raw.merchant.trim()) d.merchant = raw.merchant.trim().slice(0, 100);
  if (typeof raw.date === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.date);
    d.date = m ? plausibleDate(validYmd(+m[1], +m[2], +m[3]), today) : parseReceiptDate(raw.date, today);
    if (!d.date) delete d.date;
  }
  const cat = normalizeCategory(raw.category);
  if (typeof cat === "string" && (CATEGORIES as readonly string[]).includes(cat)) d.category = cat as Category;
  else if (d.merchant) {
    const guess = categoryFromText(d.merchant);
    if (guess) d.category = guess;
  }
  if (typeof raw.note === "string" && raw.note.trim()) d.note = raw.note.trim().slice(0, 100);
  return d;
}

export async function visionScan(
  dataUrl: string,
  today: string,
  opts: { baseUrl: string; apiKey: string; model: string; fetchImpl?: typeof fetch },
): Promise<Draft> {
  const doFetch = opts.fetchImpl ?? fetch;
  const send = (jsonMode: boolean) =>
    doFetch(`${opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0,
        max_tokens: 400,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: visionPrompt(today) },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
  let res = await send(true);
  if (res.status === 400) res = await send(false); // model without JSON mode
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const wait = res.status === 429 ? rateLimitWaitMs(res.headers, body) : undefined;
    throw new Error(`vision ${res.status}${wait !== undefined ? ` (retry in ${Math.round(wait / 1000)}s)` : ""}`);
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const json = extractJson(data.choices?.[0]?.message?.content);
  if (!json) throw new Error("vision returned no JSON");
  return normalizeDraft(json, today);
}

// ---------- entry point ----------

export async function scanReceipt(
  dataUrl: string,
  tz: string,
  opts: {
    now?: Date;
    fetchImpl?: typeof fetch;
    vision?: ReturnType<typeof visionConfig>;
    /** Counts a provider call against the user's daily budget; throws when it's used up. */
    consumeBudget?: () => Promise<void>;
  } = {},
): Promise<ReceiptScanResult> {
  const { bytes } = decodeDataUrl(dataUrl, "image");
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Image is larger than 4 MB");
  const today = localDateString(opts.now ?? new Date(), tz);

  const vision = opts.vision === undefined ? visionConfig() : opts.vision;
  if (vision) {
    await opts.consumeBudget?.();
    try {
      const draft = await visionScan(dataUrl, today, { ...vision, fetchImpl: opts.fetchImpl });
      const confidence = draft.amount && draft.merchant && draft.date ? "high" : draft.amount ? "medium" : "low";
      return { draft, confidence };
    } catch (e) {
      if (!config.isTest) console.warn("[receipts] vision failed, falling back to OCR:", (e as Error).message);
    }
  }

  try {
    const text = await (ocrOverride ?? tesseractOcr)(bytes);
    return parseReceiptText(text, today);
  } catch (e) {
    if (!config.isTest) console.warn("[receipts] OCR failed:", (e as Error).message);
    return { draft: {}, confidence: "low" };
  }
}
