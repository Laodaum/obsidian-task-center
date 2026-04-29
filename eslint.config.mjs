import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  // Obsidian-recommended rules (includes typescript-eslint, import, SDL, etc.)
  ...obsidianmd.configs.recommended,

  // Project-level ignores
  { ignores: ["main.js", "main.js.map", "node_modules/**", "test/.compiled/**"] },

  // Project-specific overrides for src/
  {
    files: ["src/**/*.ts"],
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
      // Relax unused-vars for _prefixed args (common in Obsidian callbacks)
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      // "Task Center" is our plugin's brand name — keep it capitalized
      "obsidianmd/ui/sentence-case": ["error", {
        brands: ["Task Center"],
        acronyms: ["CLI", "API", "IME", "AI", "US", "GUI"],
        enforceCamelCaseLower: true,
      }],
    },
  },
];
