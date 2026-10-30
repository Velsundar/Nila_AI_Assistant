/**
 * Text-to-speech voice picking for web (speechSynthesis) and mobile (expo-speech).
 *
 * Neither platform says whether a voice is female or male, so this guesses from well-known
 * voice names (Apple, Microsoft, Google, Android TTS ids). Unknown voices are treated as neutral,
 * and the user can always pick an exact voice in Settings.
 */

export type VoiceGender = "female" | "male";
/** User preference: a gender, or "any" for the platform default. */
export type VoiceStyle = VoiceGender | "any";
export const DEFAULT_VOICE_STYLE: VoiceStyle = "female";

/** Minimal shape both platforms can be mapped to. */
export type VoiceLike = { id: string; name: string; lang: string; quality?: string };

const FEMALE_NAMES = [
  // Apple (macOS / iOS); Tara, Veena, Isha and Kajal are Indian English
  "tara", "veena", "isha", "kajal", "lekha", "samantha", "karen", "moira", "tessa", "fiona", "victoria",
  "allison", "ava", "susan", "zoe", "serena", "kate", "nicky", "joelle", "kathy", "vicki",
  "flo", "sandy", "shelley",
  // Microsoft (Windows / Edge); Heera and Neerja are Indian English, Swara is Hindi
  "heera", "neerja", "swara", "kalpana", "zira", "aria", "jenny", "michelle", "sonia", "libby",
  "natasha", "clara", "emma", "hazel", "ana", "sara", "catherine", "linda", "eva", "maisie", "molly",
  // Google voices that say so in the name
  "female",
];
const MALE_NAMES = [
  "aman", "rishi", "ravi", "prabhat", "hemant", "madhur", "aaron", "alex", "daniel", "fred", "gordon",
  "oliver", "arthur", "rocko", "eddy", "reed", "ralph", "albert", "junior", "david", "mark", "guy",
  "ryan", "george", "james", "william", "christopher", "eric", "roger", "steffan", "brian", "thomas",
  "male",
];
// Android Google TTS voice ids look like "en-in-x-ahp-local" / "en-us-x-tpd-network".
const ANDROID_FEMALE = ["ahp", "cxx", "ene", "sfg", "tpc", "tpf", "iob", "iog", "fis", "gba", "afh"];
const ANDROID_MALE = ["end", "iom", "iol", "tpd", "rjs", "gbb", "gbd", "gbg"];

// Apple's novelty voices ("Bubbles", "Zarvox"...) and older robotic voices: never auto-pick these.
const NOVELTY = [
  "bad news", "bahh", "bells", "boing", "bubbles", "cellos", "wobble", "good news", "jester", "organ",
  "superstar", "trinoids", "whisper", "zarvox", "albert", "fred", "junior", "ralph", "grandma", "grandpa",
];
// Apple's "Eloquence" voices are understandable but robotic; prefer anything else.
const ELOQUENCE = ["eddy", "flo", "reed", "rocko", "sandy", "shelley"];

const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter(Boolean);
const firstWord = (s: string) => words(s)[0] ?? "";
const isNovelty = (name: string) => NOVELTY.some((n) => name.toLowerCase().startsWith(n));

export function guessVoiceGender(v: Pick<VoiceLike, "id" | "name">): VoiceGender | undefined {
  const tokens = new Set([...words(v.name), ...words(v.id)]);
  // "female" contains "male", so check female first and on whole words only.
  if (FEMALE_NAMES.some((n) => tokens.has(n))) return "female";
  if (MALE_NAMES.some((n) => tokens.has(n))) return "male";
  const android = /-x-([a-z]{3})-/.exec(v.id.toLowerCase())?.[1];
  if (android && ANDROID_FEMALE.includes(android)) return "female";
  if (android && ANDROID_MALE.includes(android)) return "male";
  return undefined;
}

const normLang = (l: string) => l.replace("_", "-").toLowerCase();

/** Best voice for a style and language, or undefined to let the platform choose. */
export function pickVoice<T extends VoiceLike>(voices: T[], style: VoiceStyle, lang = "en-IN"): T | undefined {
  const want = normLang(lang);
  const base = want.split("-")[0];
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const v of voices) {
    const vl = normLang(v.lang);
    // Never read English replies with a voice for another language.
    if (vl.split("-")[0] !== base || isNovelty(v.name)) continue;
    let score = vl === want ? 4 : 0;
    if (ELOQUENCE.includes(firstWord(v.name))) score -= 5;
    if (style !== "any") {
      const g = guessVoiceGender(v);
      if (g === style) score += 6;
      else if (g) score -= 20;
    }
    if (/enhanced|premium|natural|neural|online|network/i.test(`${v.name} ${v.id} ${v.quality ?? ""}`)) score += 1;
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}
