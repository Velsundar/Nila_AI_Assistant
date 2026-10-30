/** Pure text helpers shared by both speech engines (no DOM, so they can be unit-tested with tsx). */

/** Strip things that sound bad when read aloud (markdown symbols, emoji). */
export function speakable(text: string) {
  return text
    .replace(/[*_`#>]+/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/₹\s?/g, "₹")
    .replace(/\s+/g, " ")
    .trim();
}

/** Hard-split one over-long sentence at commas/spaces so no piece exceeds `max`. */
function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(" — "));
    const at = cut > max * 0.4 ? cut + 1 : window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Split a reply into sentence chunks of at most `max` chars, merging tiny sentences ("Done.")
 * into their neighbour so each server TTS request carries a sensible amount of speech.
 */
export function splitSentences(text: string, max = 350, min = 40): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = (clean.match(/[^.!?।]+[.!?।]+["')\]]*\s*|[^.!?।]+$/g) ?? [clean]).flatMap((s) => hardSplit(s, max));
  const out: string[] = [];
  let cur = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (!cur) cur = s;
    else if (cur.length < min || (cur + " " + s).length <= Math.min(max, 160)) {
      // Merge tiny pieces, and pack short sentences together up to a comfortable length.
      if ((cur + " " + s).length <= max) cur += " " + s;
      else {
        out.push(cur);
        cur = s;
      }
    } else {
      out.push(cur);
      cur = s;
    }
  }
  if (cur) {
    // A trailing tiny sentence joins the previous chunk when it fits.
    const prev = out[out.length - 1];
    if (cur.length < min && prev && (prev + " " + cur).length <= max) out[out.length - 1] = prev + " " + cur;
    else out.push(cur);
  }
  return out;
}

/**
 * Chunks for the natural (server) voice, which is metered per request (the free tier allows only
 * ~100 requests/day for the whole account): text of ≤ `single` chars is ONE request; longer text
 * is packed greedily into the fewest chunks of ≤ `max` chars, cut at sentence boundaries.
 */
export function splitForNatural(text: string, single = 400, max = 380): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= single) return [clean];
  const sentences = (clean.match(/[^.!?।]+[.!?।]+["')\]]*\s*|[^.!?।]+$/g) ?? [clean]).flatMap((s) => hardSplit(s, max));
  const out: string[] = [];
  let cur = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (cur && (cur + " " + s).length > max) {
      out.push(cur);
      cur = s;
    } else cur = cur ? cur + " " + s : s;
  }
  if (cur) out.push(cur);
  return out;
}
