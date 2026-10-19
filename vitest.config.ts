import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      COMMUNITY_ADMIN_EMAILS: "boss@example.com",
      RATE_LIMIT_SCALE: "1000",
      CLERK_WEBHOOK_SIGNING_SECRET: "whsec_test",
      STORAGE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      // never actually connected to; integration tests connect to the in-memory server explicitly
      MONGODB_URI: "mongodb://127.0.0.1:27017/unused",
    },
    // Forked workers crash intermittently on Windows with exit code 3221226505 (a native fast-fail); threads do not.
    pool: "threads",
    testTimeout: 20_000,
    hookTimeout: 120_000, // first integration run downloads the mongod binary
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts"],
    },
    projects: [
      // Pure logic: no database, no downloads. Fast feedback.
      { extends: true, test: { name: "unit", include: ["tests/unit/**/*.test.ts"] } },
      // Full HTTP stack on an in-memory MongoDB.
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/globalSetup.ts"],
        },
      },
    ],
  },
});
