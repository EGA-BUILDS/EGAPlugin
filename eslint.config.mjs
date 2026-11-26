import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [".wrangler/**", "coverage/**", "dist/**", "generated/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended
);
