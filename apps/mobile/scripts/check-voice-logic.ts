/**
 * Unit checks for the pure voice logic (no React Native needed). Run from apps/mobile:
 *   npx tsx scripts/check-voice-logic.ts
 */
import { splitIntoChunks } from "../src/lib/chunk";
import { checkEcho, looksLikeUser } from "../src/lib/echo";
import { LruIndex } from "../src/lib/lru";
import { createTurnController, type TurnOutcome } from "../src/lib/turns";
import { base64ToBytes, parseWav, trimLeadingSilence } from "../src/lib/wav";
import { naturalFailurePolicy, playChunks } from "../src/lib/speech-queue";
import { ApiError } from "@nova/shared";

let failures = 0;
let passes = 0;
function ok(cond: unknown, label: string) {
  if (cond) passes++;
  else {
    failures++;
    console.error(`FAIL: ${label}`);
  }
}
function eq<T>(a: T, b: T, label: string) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${label}\n   got ${JSON.stringify(a)}\n  want ${JSON.stringify(b)}`);
}

// ---------- chunker ----------
{
  eq(splitIntoChunks(""), [], "empty text");
  eq(splitIntoChunks("Hello there."), ["Hello there."], "one sentence");
  const reply = "Okay, I added milk. You spent ₹250 on lunch today. Your budget for food is ₹5,000 and you have ₹1,200 left. Anything else?";
  eq(splitIntoChunks(reply), [reply], "a reply of ≤ 400 chars is ONE request");
  const exactly400 = "a".repeat(399) + ".";
  eq(splitIntoChunks(exactly400).length, 1, "400 chars is still one request");
  const many = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is right here.`).join(" "); // ~1050 chars
  const mc = splitIntoChunks(many);
  ok(mc.every((x) => x.length <= 380), "long text: every chunk ≤ 380");
  eq(mc.length, Math.ceil(many.length / 380), `long text: fewest chunks (${mc.length} for ${many.length} chars)`);
  ok(mc.every((x) => x.endsWith(".")), "long text: cut at sentence boundaries");
  eq(mc.join(" "), many, "chunks rejoin to the text");
  const long = Array.from({ length: 40 }, (_, i) => `item number ${i}, which is long`).join(" ") + ".";
  const lc = splitIntoChunks(long);
  ok(lc.length > 1 && lc.every((x) => x.length <= 380), "an over-long sentence is cut under the limit");
  eq(lc.join(" ").replace(/\s+/g, " "), long, "cut sentence keeps every word");
  eq(splitIntoChunks("No punctuation at all"), ["No punctuation at all"], "text without a full stop");
}

// ---------- echo filter ----------
{
  const said = "You spent two hundred and fifty rupees on lunch today. Your food budget has twelve hundred left.";
  ok(checkEcho("you spent two hundred and fifty rupees", said).echo, "pure echo of the reply is ignored");
  ok(checkEcho("spent 250 rupees on lunch today", "You spent 250 rupees on lunch today.").echo, "echo with digits is ignored");
  ok(checkEcho("lunch", said).echo, "a single word is ignored");
  ok(checkEcho("", said).echo, "empty is ignored");
  ok(checkEcho("uh huh", "").echo === false, "2 words with nothing being spoken is not echo");
  const q = checkEcho("what's the weather tomorrow", said);
  ok(!q.echo && q.question === "what's the weather tomorrow", "a new question is not echo");
  const q2 = checkEcho("stop and add bread to my shopping list", said);
  ok(!q2.echo, "an instruction with few shared words is not echo");
  const mixed = checkEcho("your food budget has twelve hundred what is the weather tomorrow", said);
  ok(!mixed.echo && mixed.question === "what is the weather tomorrow", `user talking over echo → tail is the question (${JSON.stringify(mixed)})`);
  ok(checkEcho("your food budget has twelve hundred left okay", said).echo, "echo plus one stray word stays echo");
  ok(checkEcho("Your food budget, has twelve hundred LEFT!", said).echo, "punctuation/case-insensitive");
  ok(checkEcho("you spent", said).echo, "two echoed words are echo");
  ok(looksLikeUser("what is my balance", said), "interim user speech detected");
  ok(!looksLikeUser("on lunch today your", said), "interim echo not treated as the user");
  ok(!looksLikeUser("hey stop", said), "interim with < 3 own words waits for more");
  // Array of spoken parts (current chunk + whole reply).
  ok(checkEcho("okay I added milk", ["Okay, I added milk.", said]).echo, "matches against any spoken part");
}

// ---------- LRU ----------
{
  const lru = new LruIndex<string>(3, 1000);
  eq(lru.set("a", "fa", 100), [], "insert a");
  lru.set("b", "fb", 100);
  lru.set("ack", "fack", 50, true);
  ok(lru.get("a") === "fa", "get a (touches it)");
  const ev = lru.set("c", "fc", 100);
  eq(ev.map((e) => e.value), ["fb"], "evicts least recently used (b), not a, not pinned ack");
  const ev2 = lru.set("big", "fbig", 900);
  eq(ev2.map((e) => e.value).sort(), ["fa", "fc"], "byte limit evicts unpinned entries");
  ok(lru.has("ack") && lru.has("big"), "pinned + newest kept");
  const ev3 = lru.set("big", "fbig2", 900);
  eq(ev3.map((e) => e.value), ["fbig"], "replacing returns the old file to delete");
  const restored = new LruIndex<string>(3, 1000);
  restored.load(lru.entries());
  eq(restored.entries().map((e) => e.key), lru.entries().map((e) => e.key), "persist/restore keeps order");
}

// ---------- WAV trim ----------
{
  // 24 kHz mono Int16: 0.4 s of near-silence then 0.2 s of tone, standard 44-byte header.
  const rate = 24000;
  const silent = Math.round(0.4 * rate);
  const tone = Math.round(0.2 * rate);
  const n = silent + tone;
  const buf = new Uint8Array(44 + n * 2);
  const v = new DataView(buf.buffer);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => (buf[o + i] = ch.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i < silent ? (i % 7) - 3 : Math.round(Math.sin(i / 5) * 12000), true);
  const info = parseWav(buf);
  eq(info && [info.channels, info.sampleRate, info.bitsPerSample, info.dataOffset, info.dataBytes], [1, 24000, 16, 44, n * 2], "parses the WAV header");
  const t = trimLeadingSilence(buf);
  ok(t.trimmedMs >= 350 && t.trimmedMs <= 370, `trims ~0.36 s (0.4 s minus 40 ms pad), got ${t.trimmedMs} ms`);
  const ti = parseWav(t.bytes)!;
  ok(ti.dataBytes === t.bytes.length - 44 && new DataView(t.bytes.buffer).getUint32(4, true) === t.bytes.length - 8, "header sizes updated");
  eq(trimLeadingSilence(new Uint8Array([1, 2, 3])).trimmedMs, 0, "garbage is returned unchanged");
  eq([...base64ToBytes("TWFu")], [77, 97, 110], "base64 decode");
  eq([...base64ToBytes("TWE=")], [77, 97], "base64 decode with padding");
}

// ---------- turn controller ----------
async function checkTurns() {
  type Ev = string;
  const log: Ev[] = [];
  const resolvers: Record<string, (v: string) => void> = {};
  let concurrent = 0;
  let maxConcurrent = 0;
  const handlers = {
    run: (m: string) =>
      new Promise<string>((res) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        resolvers[m] = (v) => {
          concurrent--;
          res(v);
        };
      }),
    onStart: (m: string) => log.push(`start:${m}`),
    onSettled: (m: string, o: TurnOutcome<string>, info: { superseded: boolean }) =>
      log.push(`done:${m}:${o.ok ? o.value : "err"}:${info.superseded ? "superseded" : "spoken"}`),
  };
  const tc = createTurnController<string, string>(() => handlers);
  const tick = () => new Promise((r) => setTimeout(r, 0));

  tc.submit("q1");
  ok(tc.busy, "busy flips synchronously on submit");
  tc.interrupt(); // user taps the orb while thinking
  tc.submit("q2"); // ... and asks something else
  tc.submit("q3");
  await tick();
  eq(log, ["start:q1"], "q2/q3 wait; never in parallel");
  resolvers.q1!("a1");
  await tick();
  await tick();
  eq(log, ["start:q1", "done:q1:a1:superseded", "start:q2"], "q1 is shown as superseded (not spoken), then q2 starts");
  resolvers.q2!("a2");
  await tick();
  await tick();
  ok(log.includes("done:q2:a2:superseded"), "q2 superseded because q3 was queued behind it");
  resolvers.q3!("a3");
  await tick();
  await tick();
  ok(log[log.length - 1] === "done:q3:a3:spoken", "last answer is spoken");
  ok(!tc.busy && tc.queued.length === 0, "idle at the end");
  ok(maxConcurrent === 1, "max one request in flight");

  // Errors don't stall the queue.
  const log2: string[] = [];
  const tc2 = createTurnController<string, string>(() => ({
    run: (m) => (m === "bad" ? Promise.reject(new Error("x")) : Promise.resolve(m.toUpperCase())),
    onSettled: (m, o, i) => log2.push(`${m}:${o.ok ? o.value : "err"}:${i.superseded}`),
  }));
  tc2.submit("bad");
  tc2.submit("good");
  for (let i = 0; i < 6; i++) await tick();
  eq(log2, ["bad:err:true", "good:GOOD:false"], "a failed request still lets the next one run, in order");

  // Interrupt with nothing in flight is a no-op.
  const log3: string[] = [];
  const tc3 = createTurnController<string, string>(() => ({ run: async (m) => m, onSettled: (m, _o, i) => log3.push(`${m}:${i.superseded}`) }));
  tc3.interrupt();
  tc3.submit("x");
  for (let i = 0; i < 4; i++) await tick();
  eq(log3, ["x:false"], "interrupt while idle doesn't mark the next answer");

  // A throwing onStart doesn't wedge the controller.
  const log4: string[] = [];
  const tc4 = createTurnController<string, string>(() => ({
    run: async (m) => m,
    onStart: (m) => {
      if (m === "boom") throw new Error("ui");
    },
    onSettled: (m, o) => log4.push(`${m}:${o.ok}`),
  }));
  tc4.submit("boom");
  tc4.submit("after");
  for (let i = 0; i < 6; i++) await tick();
  eq(log4, ["boom:false", "after:true"], "an exception in onStart is reported and the queue continues");
}

// ---------- natural-voice queue + phone-voice fallback ----------
async function checkQueue() {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  type Log = string[];
  const run = async (
    chunks: string[],
    fetchImpl: (c: string) => Promise<string>,
    opts: { stopAfterPlays?: number } = {},
  ): Promise<Log> => {
    const log: Log = [];
    let alive = true;
    let plays = 0;
    await playChunks(chunks, {
      fetch: (c) => {
        log.push(`fetch:${c}`);
        return fetchImpl(c);
      },
      play: async (clip) => {
        log.push(`play:${clip}`);
        await tick();
        plays++;
        if (opts.stopAfterPlays && plays >= opts.stopAfterPlays) alive = false; // user interrupted mid-chunk
        return true;
      },
      alive: () => alive,
      onStart: () => log.push("start"),
      onDone: () => log.push("done"),
      onError: (e, rest) => log.push(`fallback:${e instanceof ApiError ? e.code : "net"}:${rest}`),
    });
    return log;
  };
  const okFetch = async (c: string) => `clip(${c})`;

  eq(await run(["A. B."], okFetch), ["fetch:A. B.", "start", "play:clip(A. B.)", "done"], "one chunk = one request");
  eq(
    await run(["A.", "B.", "C."], okFetch),
    ["fetch:A.", "fetch:B.", "start", "play:clip(A.)", "fetch:C.", "play:clip(B.)", "play:clip(C.)", "done"],
    "prefetches the next chunk before playing the current one",
  );
  const unavailable = async () => {
    throw new ApiError(503, "TTS_UNAVAILABLE", "no");
  };
  eq(await run(["A.", "B."], unavailable), ["fetch:A.", "fallback:TTS_UNAVAILABLE:A. B."], "503 on chunk 1 → whole reply goes to the phone voice");
  const fetched: string[] = [];
  await playChunks(["A.", "B."], {
    fetch: (c) => {
      fetched.push(c);
      return Promise.reject(new ApiError(503, "TTS_UNAVAILABLE", "no"));
    },
    play: async () => true,
    alive: () => true,
  });
  eq(fetched, ["A."], "after a failed chunk 1, no further requests are made");
  const rateOn2 = async (c: string) => {
    if (c === "B.") throw new ApiError(429, "TTS_RATE_LIMITED", "slow", { retryAfter: 42 });
    return `clip(${c})`;
  };
  eq(
    await run(["A.", "B.", "C."], rateOn2),
    ["fetch:A.", "fetch:B.", "start", "play:clip(A.)", "fallback:TTS_RATE_LIMITED:B. C."],
    "429 on chunk 2 → rest of the reply (B. C.) on the phone voice, no retry, chunk 3 never requested",
  );
  const net = async () => {
    throw new TypeError("Network request failed");
  };
  eq((await run(["A."], net)).pop(), "fallback:net:A.", "network error → phone voice");
  eq(
    await run(["A.", "B.", "C."], okFetch, { stopAfterPlays: 1 }),
    ["fetch:A.", "fetch:B.", "start", "play:clip(A.)"],
    "stop mid-reply: nothing else plays, no fallback, no done",
  );
  let resolveLate!: (v: string) => void;
  const log: string[] = [];
  let alive = true;
  const p = playChunks(["A."], {
    fetch: () => new Promise<string>((r) => (resolveLate = r)),
    play: async (c) => {
      log.push(`play:${c}`);
      return true;
    },
    alive: () => alive,
    onDone: () => log.push("done"),
  });
  alive = false; // stopped while the first fetch is in flight
  resolveLate("late");
  await p;
  eq(log, [], "in-flight fetch after stop is ignored");

  // Policy
  const now = 1_000_000;
  const d = (e: unknown) => (e instanceof Error ? e.message : "?");
  const p1 = naturalFailurePolicy(new ApiError(429, "TTS_RATE_LIMITED", "x", { retryAfter: 120 }), now, d);
  ok(p1.downUntil === now + 120_000 && p1.kind === "limit", "429 with retryAfter → phone voice for retryAfter seconds");
  ok(naturalFailurePolicy(new ApiError(429, "DAILY_LIMIT", "x"), now, d).downUntil === Infinity, "DAILY_LIMIT without retryAfter → rest of session");
  ok(/quota/.test(naturalFailurePolicy(new ApiError(429, "DAILY_LIMIT", "x"), now, d).text), "DAILY_LIMIT notice mentions the quota");
  ok(naturalFailurePolicy(new ApiError(503, "TTS_UNAVAILABLE", "x"), now, d).downUntil === Infinity, "503 → rest of session");
  for (const [status, code] of [[502, "TTS_FAILED"], [504, "TTS_TIMEOUT"], [500, "INTERNAL"]] as const) {
    const pp = naturalFailurePolicy(new ApiError(status, code, "x"), now, d);
    ok(pp.kind === "other" && pp.downUntil === now + 30_000, `${status} ${code} → fallback, retry after 30 s`);
  }
  ok(naturalFailurePolicy(new TypeError("Network request failed"), now, d).kind === "other", "network → fallback");
}

void checkTurns()
  .then(checkQueue)
  .then(() => {
  console.log(`${passes} passed, ${failures} failed`);
  if (failures) throw new Error(`${failures} check(s) failed`);
});
