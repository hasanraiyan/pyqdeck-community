import { z } from "zod";
import { MEMBER_ROLES } from "./member.states.js";

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");

type SocialSite = "github" | "linkedin" | "twitter";

const SITES: Record<SocialSite, { hosts: string[]; label: string; example: string; pattern: RegExp; max: number }> = {
  github: {
    hosts: ["github.com", "www.github.com"],
    label: "GitHub",
    example: "github.com/username",
    pattern: /^[A-Za-z0-9-]{1,39}$/,
    max: 39,
  },
  linkedin: {
    hosts: ["linkedin.com", "www.linkedin.com", "in.linkedin.com"],
    label: "LinkedIn",
    example: "linkedin.com/in/your-name",
    pattern: /^[A-Za-z0-9-]{3,100}$/,
    max: 100,
  },
  twitter: {
    hosts: ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"],
    label: "X (Twitter)",
    example: "x.com/username",
    pattern: /^[A-Za-z0-9_]{1,15}$/,
    max: 15,
  },
};

/**
 * What a person typed into a social field, reduced to the bare handle: `@name`, `name`, `x.com/name` and a pasted
 * profile link all work. Anything that points at another website returns null. A link is only ever read for its handle
 * and then thrown away, so no scheme or host is stored (FR-PRF-4).
 */
export function extractSocialHandle(site: SocialSite, input: string): string | null {
  const text = input.trim();
  if (text === "") return "";
  if (!/[/.:]/.test(text)) return text.replace(/^@/, ""); // already a handle

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!SITES[site].hosts.includes(url.hostname.toLowerCase())) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const segment = site === "linkedin" ? (parts[0]?.toLowerCase() === "in" ? parts[1] : undefined) : parts[0];
  if (!segment) return null;
  try {
    return decodeURIComponent(segment).replace(/^@/, "");
  } catch {
    return null;
  }
}

/** A social handle field. Accepts a handle or a profile link and stores only the handle. */
const handle = (site: SocialSite) => {
  const { label, example, pattern } = SITES[site];
  const message = `Enter your ${label} username or profile link (for example ${example})`;
  return z
    .string()
    .max(300, message)
    .transform((value, ctx) => {
      const extracted = extractSocialHandle(site, value);
      if (extracted === null || (extracted !== "" && !pattern.test(extracted))) {
        ctx.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return extracted;
    });
};

/** A website. A bare domain such as `pyqdeck.in` gets https:// added; any other scheme (http, javascript, ...) is refused. */
const httpsUrl = z
  .string()
  .trim()
  .max(2048)
  .transform((v) => (v !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(v) ? `https://${v}` : v))
  .refine((v) => {
    if (v === "") return true;
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "Use a website address such as https://example.com");

const attributes = z
  .record(z.string().max(40), z.union([z.string().max(120), z.number(), z.boolean(), z.null()]))
  .refine((v) => Object.keys(v).length <= 20, "Too many attributes");

export const updateMemberSchema = z
  .object({
    username: z.string().trim().toLowerCase().min(3).max(30),
    displayName: z.string().trim().min(1).max(80),
    headline: z.string().trim().max(120),
    bio: z.string().trim().max(500),
    location: z.string().trim().max(80),
    github: handle("github"),
    linkedin: handle("linkedin"),
    twitter: handle("twitter"),
    website: httpsUrl,
    skills: z.array(z.string().trim().min(1).max(30)).max(10),
    attributes,
    avatarMediaId: objectId.nullable(),
    coverMediaId: objectId.nullable(),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

/** Handles can contain dashes and dots, so keep this permissive; lookups are lowercased. */
export const usernameParamSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_.-]{1,64}$/, "Invalid username"),
});

export const searchMembersQuerySchema = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const suspendSchema = z.object({
  reason: z.string().trim().min(1).max(300),
  /** ISO time the suspension ends; omit for open-ended. */
  until: z.coerce.date().min(new Date()).optional(),
});

export const setRoleSchema = z.object({ role: z.enum(MEMBER_ROLES) });
