// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow unused vars prefixed with _
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Allow explicit any in some cases (can tighten later)
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow empty catch blocks (common pattern for PID file cleanup)
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "*.js", "*.mjs"],
  },
);
