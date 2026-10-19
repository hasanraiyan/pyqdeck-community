import { Filter } from "bad-words";

/**
 * A free, local first pass over text. If a word from the block list is in it, the content is refused straight away and
 * the paid moderation API is never called (saves cost and a network round trip).
 */
export interface ProfanityCheck {
  contains(text: string): boolean;
}

/** Used when the filter is switched off. */
export class NoProfanityFilter implements ProfanityCheck {
  contains(_text?: string): boolean {
    return false;
  }
}

/**
 * Words in the library's list that are normal in a study community (biology, civil engineering, everyday speech), so
 * blocking them would refuse honest posts such as "sex ratio" or "dyke breach". Extend or shrink with
 * PROFANITY_ALLOWED_WORDS. Slurs and abuse stay blocked.
 */
export const DEFAULT_ALLOWED_WORDS = [
  // biology and medicine
  "sex",
  "sexy",
  "anus",
  "anal",
  "rectum",
  "recktum",
  "vagina",
  "vulva",
  "labia",
  "penis",
  "scrotum",
  "semen",
  "testicle",
  "testical",
  "clitoris",
  "foreskin",
  "breasts",
  "orifice",
  "oriface",
  "feces",
  "enema",
  "smegma",
  "lust",
  "lusting",
  "preteen",
  "sadist",
  "masochist",
  "viagra",
  "homo",
  "cox",
  // engineering, maths and ordinary English
  "screw",
  "screwing",
  "butt",
  "balls",
  "knob",
  "knobs",
  "nob",
  "bum",
  "pawn",
  "poop",
  "fart",
  "snatch",
  "xxx",
  "lipshits",
  "lipshitz",
  "wang",
  "willy",
  // mild words and religion or history
  "hell",
  "hells",
  "damn",
  "d4mn",
  "crap",
  "cum",
  "bloody",
  "god",
  "god-dam",
  "god-damn",
  "god-damned",
  "goddamn",
  "goddamned",
  "nazi",
  "nazis",
  "dyke",
  "hoar",
];

/**
 * Abuse in Hindi written in English letters, which the library's English list does not know. Only words that are
 * not also common names or abbreviations (so no "randi", "bc" or "mc"). Extend with PROFANITY_EXTRA_WORDS.
 */
export const HINGLISH_WORDS = [
  "madarchod",
  "maderchod",
  "madarchodh",
  "behenchod",
  "bhenchod",
  "behnchod",
  "bhosdike",
  "bhosdi",
  "bhosda",
  "chutiya",
  "chutiye",
  "chutia",
  "gandu",
  "gaandu",
  "gaand",
  "harami",
  "haramzada",
  "haramzade",
  "lauda",
  "lawda",
  "bsdk",
];

const escapeRegex = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Letters people swap in to dodge filters: `sh1t`, `a$$`, `f@ck`. */
const LEET: Record<string, string> = { "@": "a", $: "s", "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" };

const INVISIBLE = new RegExp("[\u00ad\u200b-\u200d\u2060\ufeff]", "g");
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+/gi;

/**
 * The text as it will be matched, in three forms: as written (minus links and invisible characters), with look-alike
 * symbols turned back into letters, and with stretched letters squeezed (`fuuuuck`). A hit in any form counts.
 * Links are removed first because the link service judges those, and a domain name is not speech.
 */
export function profanityVariants(text: string): string[] {
  const plain = text.replace(INVISIBLE, "").replace(URL_LIKE, " ");
  const lower = plain.toLowerCase();
  const leet = lower.replace(/[@$013457]/g, (c) => LEET[c] ?? c);
  const squeezed = lower.replace(/([a-z])\1{2,}/g, "$1");
  const variants = [plain, leet, squeezed];
  // "f*ck", "f@ck" and "sh#t" hide a vowel: try each one in the hidden spot.
  if (/[*@#]/.test(lower)) for (const vowel of "uaeio") variants.push(lower.replace(/[*@#]/g, vowel));
  return [...new Set(variants)];
}

export interface ProfanityOptions {
  extraWords?: string[];
  allowedWords?: string[];
}

export class ProfanityFilter implements ProfanityCheck {
  private readonly pattern: RegExp;

  constructor({ extraWords = [], allowedWords = DEFAULT_ALLOWED_WORDS }: ProfanityOptions = {}) {
    const allowed = new Set(allowedWords.map((w) => w.toLowerCase()));
    const all = [...new Filter().list, ...HINGLISH_WORDS, ...extraWords].map((w) => w.trim().toLowerCase());

    // The library lists "*fuck*" and "*shit*" to mean "inside any word" (bullshit, fucking). Those two stems are safe to
    // match anywhere. Its other starred entries ("arse*", "cock*", "fitt*") would also catch arsenic, cockpit and
    // fittings, so they are ignored, exactly as the library itself ignores them.
    const stems = all.filter((w) => /^\*[a-z]{3,}\*$/.test(w)).map((w) => w.slice(1, -1));
    const words = all.filter((w) => w.length > 0 && !w.includes("*") && !allowed.has(w));

    // One regex instead of the library's ~700 per call. Same rule as the library for whole words: any case, whole word.
    // Longest first so "motherfucker" is not reported as "fuck".
    const unique = [...new Set(words)].sort((x, y) => y.length - x.length).map(escapeRegex);
    const wholeWord = String.raw`(?<![\p{L}\p{N}_])(?:${unique.join("|")})(?![\p{L}\p{N}_])`;
    const inside = stems.filter((stem) => !allowed.has(stem)).map(escapeRegex);
    this.pattern = new RegExp(inside.length ? `${wholeWord}|(?:${inside.join("|")})` : wholeWord, "iu");
  }

  contains(text: string): boolean {
    return profanityVariants(text).some((variant) => this.pattern.test(variant));
  }
}
