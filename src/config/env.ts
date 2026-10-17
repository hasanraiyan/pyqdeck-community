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
  // Share of each storage account kept free, so we never fill an account to the brim.
  STORAGE_HEADROOM_PERCENT: z.coerce.number().min(0).max(50).default(5),
  // Content moderation (OpenAI Moderation API). Required in production so moderation can never be silently off.
  OPENAI_API_KEY: z.string().optional(),
  MODERATION_MODEL: z.string().default("omni-moderation-latest"),
  MODERATION_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(8000),
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
