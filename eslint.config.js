// @ts-check
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Recommended type-checked rules for all src and test TypeScript files
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Ignore _-prefixed parameters and variables (used for intentional unused stubs)
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Test files: relax rules that create noise in stub/fake/mock code
  {
    files: ["test/**/*.ts"],
    rules: {
      // node:test's test() returns a Promise handled by the runner — not a float
      "@typescript-eslint/no-floating-promises": "off",
      // Stub/fake implementations of async interfaces don't need await internally
      "@typescript-eslint/require-await": "off",
      // Test stub arrays typed as any[] at SDK boundaries
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // Domain layer: must never import from infrastructure or the pi SDK
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "infra/",
              message: "Domain layer must not depend on infrastructure. Use domain types only.",
            },
            {
              regex: "@earendil-works/",
              message: "Domain layer must not depend on the pi SDK. Use domain types only.",
            },
          ],
        },
      ],
    },
  },

  // Application layer: infrastructure and SDK imports are errors.
  // codec/* is allowed as an anti-corruption layer for markdown parsing.
  {
    files: ["src/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "infra/git/",
              message: "Application layer should use the VersionControl port, not the git adapter directly.",
            },
            {
              regex: "infra/fs/",
              message:
                "Application layer should use the RunStateRepository/ArtifactRepository ports, not fs adapters directly.",
            },
            {
              regex: "infra/pi/(human-gate|stage-return-tool|session-dispatcher|progress-reporter)",
              message: "Application layer should use ports (GateManager, PipelineServices), not pi adapters directly.",
            },
            {
              regex: "infra/telemetry/",
              message: "Application layer should use the TelemetrySink port, not the telemetry adapter directly.",
            },
            {
              regex: "@earendil-works/",
              message:
                "Application layer must not depend on the pi SDK. Use ports defined in application/port/index.ts.",
            },
          ],
        },
      ],
    },
  },

  // Global ignores
  {
    ignores: ["node_modules/**", ".pipeline/**", "**/*.d.ts", "eslint.config.js"],
  },
);
