import { rmSync } from "node:fs";
import { $ } from "bun";

// Derive externals from package.json dependencies
const pkg = await Bun.file("package.json").json();
const external = Object.keys(pkg.dependencies ?? {});

// Clean
rmSync("dist", { recursive: true, force: true });

// Bundle library + CLI in parallel
const [lib, cli] = await Promise.all([
  Bun.build({
    entrypoints: ["src/index.ts"],
    outdir: "dist",
    naming: "index.js",
    minify: true,
    target: "node",
    format: "esm",
    external,
  }),
  Bun.build({
    entrypoints: ["bin/cli.ts"],
    outdir: "dist",
    naming: "cli.js",
    minify: true,
    target: "node",
    format: "esm",
    external: [...external, "@/logger", "@/proxy"],
  }),
]);

if (!lib.success) {
  console.error("Library build failed:", lib.logs);
  process.exit(1);
}
if (!cli.success) {
  console.error("CLI build failed:", cli.logs);
  process.exit(1);
}

// Rewrite @/ imports to point at the bundled library
const cliPath = "dist/cli.js";
const cliCode = await Bun.file(cliPath).text();
await Bun.write(
  cliPath,
  cliCode.replace(/from"@\/(logger|proxy)"/g, 'from"./index.js"'),
);

// Generate single-file type declarations
await $`bunx dts-bundle-generator -o dist/index.d.ts src/index.ts --project tsconfig.build.json --no-check`;

console.log("Build complete.");
