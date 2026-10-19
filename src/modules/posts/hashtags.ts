export const MAX_HASHTAGS = 10;
const HASHTAG = /(?<![\w&])#([A-Za-z0-9_-]+)/g;

/**
 * Hashtags of a text that has already had its URLs removed (FR-LNK-6): de-duplicated case-insensitively, first
 * spelling kept, at most ten (FR-POST-4). A tag must start at a word boundary, so `a#b` and `&#39;` are not tags.
 */
export function extractHashtags(textWithoutUrls: string): { display: string[]; lower: string[] } {
  const seen = new Map<string, string>();
  for (const m of textWithoutUrls.matchAll(HASHTAG)) {
    const lower = m[1].toLowerCase();
    if (!seen.has(lower)) seen.set(lower, m[1]);
    if (seen.size >= MAX_HASHTAGS) break;
  }
  return { display: [...seen.values()], lower: [...seen.keys()] };
}

/** `Explaining Dijkstra's algorithm` -> `explaining-dijkstra-s-algorithm`, for the human-readable part of a slug. */
export const slugify = (text: string, max = 40) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
