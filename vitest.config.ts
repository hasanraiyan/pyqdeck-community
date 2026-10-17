import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/globalSetup.ts"],
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      // never actually connected to; tests connect to the in-memory server explicitly
      MONGODB_URI: "mongodb://127.0.0.1:27017/unused",
    },
    testTimeout: 20_000,
    hookTimeout: 120_000, // first run downloads the mongod binary
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts"],
    },
  },
});
