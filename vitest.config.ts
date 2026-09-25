import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/server/src/**/*.spec.ts", "packages/*/src/**/*.spec.ts", "apps/web/src/app/core/*.spec.ts", "apps/web/src/app/shared/pixel-office/*.spec.ts"],
    // Orchestrator tests spawn real git and (fake) claude processes per step.
    testTimeout: 30_000,
  },
});
