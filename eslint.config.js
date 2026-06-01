import js from "@eslint/js";
import globals from "globals";

/**
 * Flat ESLint config for a no-build MV3 extension.
 *
 * The codebase spans three distinct runtime environments, each with its own
 * globals: the background service worker / content script, the browser-context
 * UI pages (side panel, editor, options, offscreen), and the Node-based test
 * suite. `chrome` is a readonly global in every extension context.
 *
 * `vendor/` (third-party gif.js) is ignored — it is minified and not ours to lint.
 */
export default [
  {
    ignores: ["vendor/**", "node_modules/**", "dist/**", "fonts/**", "coverage/**"],
  },

  js.configs.recommended,

  // Background service worker + content script + shared engine modules.
  {
    files: ["service_worker.js", "content_script.js", "db.js", "llm.js", "export.js", "utils.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.serviceworker,
        ...globals.browser,
        chrome: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },

  // Browser-context UI pages.
  {
    files: ["sidepanel/**/*.js", "editor/**/*.js", "options/**/*.js", "offscreen/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.browser,
        chrome: "readonly",
        GIF: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },

  // Test suite.
  {
    files: ["tests/**/*.js", "**/*.test.js", "vitest.config.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
        chrome: "readonly",
      },
    },
  },

];
