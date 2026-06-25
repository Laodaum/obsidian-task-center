import obsidianmd from "eslint-plugin-obsidianmd";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";

export default [
  // Obsidian-recommended rules (includes typescript-eslint, import, SDL, etc.)
  ...obsidianmd.configs.recommended,

  // Project-level ignores
  { ignores: ["main.js", "main.js.map", "node_modules/**", "test/.compiled/**"] },

  // Project-specific overrides for src/
  {
    files: ["src/**/*.ts"],
    plugins: {
      "@eslint-community/eslint-comments": eslintComments,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // We intentionally use node modules (fs, path) behind Platform.isDesktop guards
      "obsidianmd/no-nodejs-modules": "off",
      // Sample-code / sample-names are boilerplate detections — not relevant
      "obsidianmd/no-sample-code": "off",
      "obsidianmd/sample-names": "off",
      // We store a map of leaves → not a direct view reference
      "obsidianmd/no-view-references-in-plugin": "off",
      // We runtime-gate newer APIs (registerCliHandler, revealLeaf, etc.)
      // behind feature detection — bumping minAppVersion would break
      // compatibility with older Obsidian installs.
      "obsidianmd/no-unsupported-api": "off",
      // Match the Obsidian review bot more closely: unused locals are errors,
      // even when prefixed with "_"; only callback args may use that convention.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/require-await": "error",
      "@eslint-community/eslint-comments/require-description": "error",
      "@eslint-community/eslint-comments/no-restricted-disable": [
        "error",
        "*",
      ],
    },
  },
];
