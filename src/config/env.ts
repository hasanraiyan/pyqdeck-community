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
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

const parsed = schema
  .refine(
    (e) =>
      e.NODE_ENV !== "production" || (e.CLERK_PUBLISHABLE_KEY && e.CLERK_SECRET_KEY && e.CLERK_WEBHOOK_SIGNING_SECRET),
    { message: "CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY and CLERK_WEBHOOK_SIGNING_SECRET are required in production" },
  )
  .safeParse(process.env);
if (!parsed.success) {
  // logger depends on env, so this is the one place that must use console
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
