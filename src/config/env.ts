import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(5000),
  MONGODB_URI: z.string().min(1),
  CORS_ORIGIN: z.string().default("*"),
  // Same Clerk instance as the main PYQDeck server (users are shared, data is not).
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().optional(),
  // Verified Clerk emails that become community admins on first sign-in.
  COMMUNITY_ADMIN_EMAILS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  // 32 random bytes, base64 (openssl rand -base64 32). Encrypts storage account credentials at rest.
  STORAGE_ENCRYPTION_KEY: z
    .string()
    .optional()
    .refine((v) => !v || Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64 encoded"),
  // Optional: one Cloudinary account taken from the environment, so images work without calling the admin API.
  // On boot it is created (or its keys updated) as the storage account named "cloudinary-env". More accounts can still
  // be added at runtime through /api/v1/admin/storage/accounts.
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
  // Soft limit for that account, in GB. Keep it a little below what your Cloudinary plan really allows.
  CLOUDINARY_CAPACITY_GB: z.coerce.number().positive().max(1024).default(2),
  // Share of each storage account kept free, so we never fill an account to the brim.
  STORAGE_HEADROOM_PERCENT: z.coerce.number().min(0).max(50).default(5),
  // Content moderation (OpenAI Moderation API). Required in production so moderation can never be silently off.
  OPENAI_API_KEY: z.string().optional(),
  // Local word filter that runs before the moderation API: a hit is refused without calling the API.
  PROFANITY_FILTER: z
    .string()
    .default("true")
    .transform((v) => v.trim().toLowerCase() !== "false"),
  // Extra words to block / words to let through, comma separated (lower case).
  PROFANITY_EXTRA_WORDS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  PROFANITY_ALLOWED_WORDS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  MODERATION_MODEL: z.string().default("omni-moderation-latest"),
  MODERATION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(8000),
  // Which hosts this process serves: both (selected by hostname), only the JSON API, or only short-link redirects (NFR-PRT-2).
  SERVE_MODE: z.enum(["all", "api", "links"]).default("all"),
  // Hostname that serves short links. A setting, never stored in content, so it can change without a migration.
  LINK_HOST: z.string().default("go.pyqdeck.in"),
  LINK_CODE_LENGTH: z.coerce.number().int().min(8).max(16).default(8),
  // A link is re-checked at click time when its last check is older than this.
  LINK_RECHECK_HOURS: z.coerce.number().min(0).default(24),
  // Number of reverse proxies in front (Render = 1) so req.ip and req.hostname are the real client values.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  // Communities created on boot when missing, comma separated slugs.
  SEED_COMMUNITIES: z
    .string()
    .default("beu")
    .transform((v) =>
      v
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  // Multiplies every rate limit. Raise it for load tests; leave it at 1 in production.
  RATE_LIMIT_SCALE: z.coerce.number().min(0.1).default(1),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

/** Optional locally, mandatory in production so auth, storage encryption and moderation can never be silently off. */
const REQUIRED_IN_PRODUCTION = [
  "CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "CLERK_WEBHOOK_SIGNING_SECRET",
  "STORAGE_ENCRYPTION_KEY",
  "OPENAI_API_KEY",
] as const;

const parsed = schema
  .refine((e) => e.NODE_ENV !== "production" || REQUIRED_IN_PRODUCTION.every((key) => Boolean(e[key])), {
    message: `${REQUIRED_IN_PRODUCTION.join(", ")} are required in production`,
  })
  .safeParse(process.env);
if (!parsed.success) {
  // logger depends on env, so this is the one place that must use console
  const { formErrors, fieldErrors } = parsed.error.flatten();
  console.error("Invalid environment variables:", [...formErrors, ...Object.entries(fieldErrors)]);
  process.exit(1);
}

export const env = parsed.data;
