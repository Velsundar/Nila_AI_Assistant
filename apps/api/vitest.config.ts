import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      MONGODB_URI: process.env.MONGODB_TEST_URI || "mongodb://127.0.0.1:27017/nova_test",
      JWT_SECRET: "test-secret",
      LLM_PROVIDER: "mock",
      LLM_API_KEY: "",
    },
  },
});
