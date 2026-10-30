/**
 * Splits a reply into as FEW natural-voice requests as possible (the Groq free tier allows only
 * ~100 Orpheus requests a day for the whole account):
 *  - text of ≤ `single` (400, the API limit) characters is one request;
 *  - longer text is packed greedily into chunks of ≤ `max` (380) characters, cut at sentence
 *    boundaries; an over-long sentence is cut at a comma/semicolon, then at a word boundary.
 */
export function splitIntoChunks(text: string, max = 380, single = 400): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= single) return [clean];
  // Sentence ends: . ! ? … followed by space (keeps "₹2.50" and "e.g." mostly intact).
  const sentences = clean.match(/[^.!?…]+(?:[.!?…]+["')\]]*|$)\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [clean];

  const pieces: string[] = [];
  for (const s of sentences) {
    if (s.length <= max) pieces.push(s);
    else pieces.push(...splitLong(s, max));
  }

  const chunks: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && cur.length + 1 + p.length > max) {
      chunks.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur} ${p}` : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function splitLong(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(": "));
    if (cut < max * 0.4) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    else cut += 1; // keep the punctuation with the left part
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
