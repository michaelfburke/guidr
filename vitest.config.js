import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.js"],
    include: ["tests/**/*.test.js"],
    coverage: {
      provider: "v8",
      include: ["utils.js", "export.js", "llm.js", "db.js", "sidepanel/annotate.js"],
    },
  },
});
