import { afterEach, describe, expect, it, vi } from "vitest";
import { api, registerUser } from "../test/helpers";
import { parseReceiptText, scanReceipt, setReceiptOcr, visionScan } from "../services/receipts";
import { audioExtension, transcribe } from "../services/transcribe";

const IMG = "data:image/png;base64," + Buffer.from("fake-png-bytes").toString("base64");
const OCR_TEXT = `MEGHANA FOODS
Koramangala, Bengaluru
GSTIN 29ABCDE1234F1Z5
Date: 28/10/2026 Time: 13:42
Bill No: 4471
Chicken Biryani 1 x 320 320.00
Subtotal 740.00
CGST 2.5% 18.50
TOTAL Rs 777.00`;

afterEach(() => setReceiptOcr(undefined));

describe("POST /api/receipts/scan", () => {
  it("returns a draft from OCR (mock mode) and never saves an expense", async () => {
    setReceiptOcr(async () => OCR_TEXT);
    const { auth } = await registerUser();
    const r = await api().post("/api/receipts/scan").set(auth).send({ image: IMG });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      draft: { amount: 777, merchant: "Meghana Foods", date: "2026-10-28", category: "Food" },
      confidence: "medium",
    });
    expect((await api().get("/api/expenses").set(auth)).body.expenses).toEqual([]);
  });

  it("returns an empty low-confidence draft when OCR fails", async () => {
    setReceiptOcr(async () => {
      throw new Error("boom");
    });
    const { auth } = await registerUser();
    const r = await api().post("/api/receipts/scan").set(auth).send({ image: IMG });
    expect(r.body).toEqual({ draft: {}, confidence: "low" });
  });

  it("validates input, requires auth, and accepts bodies above the global 100 kB limit", async () => {
    setReceiptOcr(async () => "");
    expect((await api().post("/api/receipts/scan").send({ image: IMG })).status).toBe(401);
    const { auth } = await registerUser();
    const bad = await api().post("/api/receipts/scan").set(auth).send({ image: "data:text/plain;base64,aGk=" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
    const big = "data:image/jpeg;base64," + Buffer.alloc(2 * 1024 * 1024, 1).toString("base64"); // ~2.7 MB body
    expect((await api().post("/api/receipts/scan").set(auth).send({ image: big })).status).toBe(200);
    const huge = "data:image/jpeg;base64," + Buffer.alloc(5 * 1024 * 1024, 1).toString("base64"); // ~7 MB body
    const tooBig = await api().post("/api/receipts/scan").set(auth).send({ image: huge });
    expect(tooBig.status).toBe(413);
    expect(tooBig.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    // Other routes keep the small limit.
    expect((await api().post("/api/notes").set(auth).send({ text: "x".repeat(200_000) })).status).toBe(413);
  });

  it("uses a vision model with JSON output when configured", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"amount":"₹1,249.50","merchant":"DMart","date":"2026-10-27","category":"grocery","note":"groceries"}' } }] }),
        { status: 200 },
      ),
    );
    const r = await scanReceipt(IMG, "Asia/Kolkata", {
      now: new Date("2026-10-30T10:00:00Z"),
      vision: { baseUrl: "https://x/v1", apiKey: "k", model: "qwen/qwen3.8-27b" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ draft: { amount: 1249.5, merchant: "DMart", date: "2026-10-27", category: "Groceries", subcategory: "Supermarket", note: "groceries" }, confidence: "high" });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.model).toBe("qwen/qwen3.8-27b");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].content[1]).toEqual({ type: "image_url", image_url: { url: IMG } });
  });

  it("falls back to OCR when the vision model is rate-limited", async () => {
    setReceiptOcr(async () => OCR_TEXT);
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } }));
    const r = await scanReceipt(IMG, "Asia/Kolkata", {
      now: new Date("2026-10-30T10:00:00Z"),
      vision: { baseUrl: "https://x/v1", apiKey: "k", model: "m" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.draft.amount).toBe(777);
    expect(r.confidence).toBe("medium");
  });

  it("rejects implausible dates and drops nonsense from vision output", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Sure! {"amount":null,"merchant":"","date":"1999-01-01"}' } }] }), { status: 200 }));
    const d = await visionScan(IMG, "2026-10-30", { baseUrl: "https://x", apiKey: "k", model: "m", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(d).toEqual({});
  });

  it("parses common receipt text formats", () => {
    const r = parseReceiptText("BIG BAZAAR\nTax Invoice\n12 Oct 2026\nItems 5\nGrand Total : 2,340.00\nCash 2,500.00", "2026-10-30");
    expect(r.draft).toMatchObject({ amount: 2340, merchant: "Big Bazaar", date: "2026-10-12" });
    expect(parseReceiptText("", "2026-10-30")).toEqual({ draft: {}, confidence: "low" });
  });

  it("fills a subcategory from the merchant or the model's guess", async () => {
    expect(parseReceiptText("Swiggy\n02/11/2026\nTotal 349.00", "2026-11-05").draft).toMatchObject({ category: "Food", subcategory: "Swiggy" });
    expect(parseReceiptText("Indian Oil Petrol Pump\n01/11/2026\nTotal 500.00", "2026-11-05").draft).toMatchObject({ category: "Vehicle", subcategory: "Fuel" });
    const reply = (content: string) => vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }));
    const opts = { baseUrl: "https://x", apiKey: "k", model: "m" };
    const fromModel = await visionScan(IMG, "2026-11-05", { ...opts, fetchImpl: reply('{"amount":420,"merchant":"PVR","category":"Life & Entertainment","subcategory":"theater","note":"Leo movie"}') as unknown as typeof fetch });
    expect(fromModel).toMatchObject({ category: "Life & Entertainment", subcategory: "Theatre" });
    const inferred = await visionScan(IMG, "2026-11-05", { ...opts, fetchImpl: reply('{"amount":250,"merchant":"Zomato","category":"Food","subcategory":null}') as unknown as typeof fetch });
    expect(inferred).toMatchObject({ category: "Food", subcategory: "Zomato" });
  });
});

describe("POST /api/transcribe", () => {
  it("returns 503 STT_UNAVAILABLE without a key (tests run in mock mode)", async () => {
    const { auth } = await registerUser();
    const r = await api().post("/api/transcribe").set(auth).send({ audio: "data:audio/m4a;base64,AAAA" });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("STT_UNAVAILABLE");
    expect((await api().post("/api/transcribe").set(auth).send({ audio: "nope" })).status).toBe(400);
    expect((await api().post("/api/transcribe").send({ audio: "data:audio/m4a;base64,AAAA" })).status).toBe(401);
  });

  it("posts multipart audio to Whisper", async () => {
    let form: FormData | undefined;
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      form = init.body as FormData;
      return new Response(JSON.stringify({ text: " spent 200 on lunch. " }), { status: 200 });
    });
    const audio = "data:audio/webm;codecs=opus;base64," + Buffer.from("opus-bytes").toString("base64");
    const out = await transcribe(audio, "en", {
      stt: { baseUrl: "https://api.groq.com/openai/v1", apiKey: "k", model: "whisper-large-v3-turbo" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toEqual({ text: "spent 200 on lunch." });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(form!.get("model")).toBe("whisper-large-v3-turbo");
    expect(form!.get("language")).toBe("en");
    const file = form!.get("file") as File;
    expect(file.name).toBe("audio.webm");
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe("opus-bytes");
  });

  it("maps Whisper 429 to STT_RATE_LIMITED", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "12" } }));
    await expect(
      transcribe("data:audio/wav;base64,AAAA", undefined, { stt: { baseUrl: "https://x", apiKey: "k", model: "m" }, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 429, code: "STT_RATE_LIMITED" });
  });

  it("maps MIME types to Whisper-friendly extensions", () => {
    expect(audioExtension("audio/m4a")).toBe("m4a");
    expect(audioExtension("audio/x-m4a")).toBe("m4a");
    expect(audioExtension("audio/mp4")).toBe("m4a");
    expect(audioExtension("audio/mpeg")).toBe("mp3");
    expect(audioExtension("audio/wav")).toBe("wav");
    expect(audioExtension("audio/ogg")).toBe("ogg");
  });
});
