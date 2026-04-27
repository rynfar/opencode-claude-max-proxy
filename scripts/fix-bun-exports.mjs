#!/usr/bin/env node
/**
 * fix-bun-exports.mjs
 *
 * Bun's bundler emits duplicate `export {}` blocks and `__INVALID__REF__`
 * references in code-split chunks. This script cleans up both issues in dist/.
 *
 * Run automatically via the `postbuild` npm script.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { glob } from "glob";

const distDir = new URL("../dist/", import.meta.url).pathname;
const files = await glob("**/*.js", { cwd: distDir });
let totalFixed = 0;

/**
 * Extract symbol names from an export block string, filtering out
 * __INVALID__REF__ which is a Bun bundler artifact.
 */
function extractExportSymbols(block) {
  return block
    .replace(/^export\s*\{/, "")
    .replace(/\}\s*;?\s*$/, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "__INVALID__REF__");
}

for (const rel of files) {
  const path = distDir + rel;
  const src = readFileSync(path, "utf-8");
  let out = src;

  // 1. Remove __INVALID__REF__ imports
  //    e.g. import { __INVALID__REF__ } from "./server.js";
  out = out.replace(
    /^import\s*\{\s*__INVALID__REF__\s*\}\s*from\s*"[^"]*"\s*;?\s*\n?/gm,
    ""
  );

  // 2. Find all export blocks (both single-line and multi-line).
  //    Uses the dotAll flag (s) so . matches newlines within the non-greedy
  //    match between { and }.
  const exportRe = /^export\s*\{[\s\S]*?\}\s*;?$/gm;
  const blocks = [...out.matchAll(exportRe)];

  if (blocks.length > 0) {
    const canonicalSymbols = new Set(extractExportSymbols(blocks[0][0]));

    // Remove __INVALID__REF__ from the canonical block if present
    if (blocks[0][0].includes("__INVALID__REF__")) {
      const cleaned = blocks[0][0]
        .replace(/\s*__INVALID__REF__\s*,\s*/, "")
        .replace(/,\s*__INVALID__REF__\s*/, "");
      out = out.replace(blocks[0][0], cleaned);
    }

    // Remove subsequent blocks whose real symbols are all in the canonical set
    for (let i = blocks.length - 1; i >= 1; i--) {
      const block = blocks[i][0];
      const symbols = extractExportSymbols(block);
      if (
        symbols.length === 0 ||
        symbols.every((s) => canonicalSymbols.has(s))
      ) {
        out = out.replace(block, "");
      }
    }
  }

  // 3. Clean up multiple consecutive blank lines left behind
  out = out.replace(/\n{3,}/g, "\n\n");

  if (out !== src) {
    writeFileSync(path, out);
    totalFixed++;
    console.log(`  fixed: ${rel}`);
  }
}

if (totalFixed > 0) {
  console.log(`fix-bun-exports: patched ${totalFixed} file(s)`);
} else {
  console.log("fix-bun-exports: no issues found");
}
