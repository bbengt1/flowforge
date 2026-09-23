import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tsParser from "@typescript-eslint/parser";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // eslint-config-next sets settings.react.version to "detect".
  // eslint-plugin-react 7.37.5 then calls context.getFilename(), which
  // ESLint 10 removed. An explicit version skips that path.
  // JS/MJS still uses Next's Babel parser, which lacks ESLint 10's
  // ScopeManager#addGlobals. Those files use the TypeScript parser.
  {
    settings: {
      react: {
        version: "19.2.8",
      },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs,jsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
