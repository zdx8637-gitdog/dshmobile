import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      RELAY_DEV_TOKEN: "test-dev-token-fixed-for-test-suite",
    },
  },
});
