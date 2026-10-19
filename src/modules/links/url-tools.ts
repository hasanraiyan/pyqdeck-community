import { isIP } from "node:net";

/** Pure URL handling for the link service: finding URLs in Markdown text, normalising and vetting them. */

export interface UrlSpan {
  start: number;
  end: number;
  raw: string;
}

export const MAX_URL_LENGTH = 2048;

const blank = (text: string, start: number, end: number) =>
  text.slice(0, start) + " ".repeat(end - start) + text.slice(end);

/** Replaces code blocks, code spans and LaTeX math with spaces (same length), so nothing inside them is a link. */
export function maskNonProse(text: string): string {
  let masked = text;
  const mask = (re: RegExp) => {
    for (const m of masked.matchAll(re)) masked = blank(masked, m.index, m.index + m[0].length);
  };
  mask(/```[\s\S]*?(?:```|$)/g); // fenced code, including an unterminated one
  mask(/`[^`\n]+`/g); // inline code
  mask(/\$\$[\s\S]+?\$\$/g); // display math
  mask(/\$(?!\s)[^$\n]+?(?<!\s)\$/g); // inline math; "$5 and $10" is not math because of the spaces
  return masked;
}

// A bracketed IPv6 host is allowed right after the scheme; brackets elsewhere end the URL (Markdown syntax).
const URL_PATTERN = /https?:\/\/(?:\[[0-9a-f:.]+\][^\s<>[\]()"'`]*|[^\s<>[\]()"'`]+)/gi;
const TRAILING = /[.,;:!?*_~]+$/;

/** Bare URLs, `[text](url)` destinations and `<url>` autolinks all contain the URL itself, so one scan finds them. */
export function extractUrls(text: string): UrlSpan[] {
  const masked = maskNonProse(text);
  const spans: UrlSpan[] = [];
  for (const m of masked.matchAll(URL_PATTERN)) {
    const trimmed = m[0].replace(TRAILING, "");
    spans.push({ start: m.index, end: m.index + trimmed.length, raw: trimmed });
  }
  return spans;
}

/** The first non-http(s) scheme used as a Markdown link destination or autolink (`javascript:`, `data:` ...), if any. */
export function findForbiddenScheme(text: string): string | null {
  const masked = maskNonProse(text);
  const candidates = [
    ...masked.matchAll(/\]\(\s*<?([^)\s>]+)/g),
    ...masked.matchAll(/<([a-z][a-z0-9+.-]*:[^\s>]*)>/gi),
  ];
  for (const m of candidates) {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(m[1])?.[1]?.toLowerCase();
    if (scheme && scheme !== "http" && scheme !== "https") return scheme;
  }
  return null;
}

export type UrlRejection = "too_long" | "bad_scheme" | "credentials" | "internal_host" | "invalid";

export class UrlRejected extends Error {
  constructor(readonly reason: UrlRejection) {
    super(reason);
  }
}

function isPrivateIpv4(host: string) {
  const [a, b] = host.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isInternalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) {
    const h = host.toLowerCase();
    return (
      h === "::" ||
      h === "::1" ||
      h.startsWith("fe80:") ||
      h.startsWith("fc") ||
      h.startsWith("fd") ||
      h.startsWith("::ffff:")
    );
  }
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  );
}

export interface NormalizedUrl {
  href: string;
  host: string;
}

/**
 * Lower-cases scheme and host, drops the default port and converts an internationalised host to punycode (the WHATWG
 * parser does all three), then rejects anything unsafe to redirect to (FR-LNK-9, FR-LNK-10).
 */
export function normalizeUrl(raw: string): NormalizedUrl {
  if (raw.length > MAX_URL_LENGTH) throw new UrlRejected("too_long");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlRejected("invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UrlRejected("bad_scheme");
  if (url.username || url.password) throw new UrlRejected("credentials");
  const host = url.hostname.replace(/\.$/, "");
  if (isInternalHost(host)) throw new UrlRejected("internal_host");
  url.hostname = host;
  if (url.href.length > MAX_URL_LENGTH) throw new UrlRejected("too_long");
  return { href: url.href, host };
}

/** True when the host is `domain` or one of its subdomains. */
export const hostMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** An internationalised host (punycode label) can imitate a trusted brand, so it always gets the warning page. */
export const isLookalikeHost = (host: string) => host.split(".").some((label) => label.startsWith("xn--"));

export const REJECTION_MESSAGES: Record<UrlRejection, string> = {
  too_long: "A link is too long (2,048 characters at most)",
  bad_scheme: "Only http and https links are allowed",
  credentials: "Links containing a username or password are not allowed",
  internal_host: "Links to internal or private addresses are not allowed",
  invalid: "One of the links is not a valid web address",
};
