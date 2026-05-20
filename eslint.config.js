import tsParser from "@typescript-eslint/parser";
import globals from "globals";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.d.ts",
      "**/*.js",
      "**/*.map",
      "**/*.json",
      "package-lock.json",
    ],
  },
  {
    files: ["packages/**/*.ts", "apps/**/*.ts", "bench/**/*.mjs"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": "off",
      "no-undef": "off",
      "no-empty": "off",
      "no-console": "off",
    },
  },
];
