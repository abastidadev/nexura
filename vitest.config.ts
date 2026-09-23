import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/server/src/**/*.spec.ts", "packages/*/src/**/*.spec.ts"],
  },
});
