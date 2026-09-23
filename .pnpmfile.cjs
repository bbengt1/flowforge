// typescript-eslint 8.70 loads require("typescript") and throws on
// TypeScript 7.0 (no programmatic API until 7.1). Nest the TypeScript 6
// API package for those modules only. The app's typescript dependency
// stays on 7 so next build's CLI typecheck and tsc use TypeScript 7.
const typescript6 = "npm:@typescript/typescript6@6.0.2";

const typescriptEslintPackages = new Set([
  "typescript-eslint",
  "@typescript-eslint/eslint-plugin",
  "@typescript-eslint/parser",
  "@typescript-eslint/project-service",
  "@typescript-eslint/tsconfig-utils",
  "@typescript-eslint/type-utils",
  "@typescript-eslint/typescript-estree",
  "@typescript-eslint/utils",
]);

function readPackage(pkg) {
  if (!typescriptEslintPackages.has(pkg.name)) {
    return pkg;
  }
  pkg.dependencies = pkg.dependencies ?? {};
  pkg.dependencies.typescript = typescript6;
  if (pkg.peerDependencies?.typescript) {
    delete pkg.peerDependencies.typescript;
  }
  if (pkg.peerDependenciesMeta?.typescript) {
    delete pkg.peerDependenciesMeta.typescript;
  }
  return pkg;
}

module.exports = {
  hooks: {
    readPackage,
  },
};
