// TypeScript 6 rejects a side-effect import of a module it has no declaration
// for, and Next's own types do not cover plain .css imports. This is that
// declaration: `import "./globals.css"` is a build-pipeline instruction, not a
// value import, so the module has no shape worth describing.
declare module "*.css";
