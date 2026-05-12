#!/usr/bin/env node
/**
 * fix-bun-exports.mjs
 *
 * Bun's bundler emits duplicate `export {}` blocks and `__INVALID__REF__`
 * references in code-split chunks. This script cleans up both issues in dist/.
 *
 * Run automatically via the `postbuild` npm script.
 *
 * Exposes `fixBunExports(distDir)` for unit testing — see
 * src/__tests__/fix-bun-exports.test.ts for fixtures that lock in the
 * supported Bun output patterns.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "glob";

/**
 * Extract symbol names from an export block string, filtering out
 * __INVALID__REF__ which is a Bun bundler artifact.
 */
export function extractExportSymbols(block) {
  return block
    .replace(/^export\s*\{/, "")
    .replace(/\}\s*;?\s*$/, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "__INVALID__REF__");
}

/**
 * Patch a single file's source string, returning either the cleaned text
 * or the original (unchanged) string. Pure: takes input, returns output.
 */
export function patchSource(src) {
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

    // Remove __INVALID__REF__ from the canonical block if present.
    // Rebuild from parsed symbols rather than chained regex replaces so the
    // formatting stays clean — the original chained-replace approach swallowed
    // the newline before `}` and produced output like `realThing};`.
    if (blocks[0][0].includes("__INVALID__REF__")) {
      const symbols = extractExportSymbols(blocks[0][0]);
      const cleaned = symbols.length > 0
        ? `export {\n  ${symbols.join(",\n  ")}\n};`
        : "";
      out = out.replace(blocks[0][0], cleaned);
    }

    // Deduplicate subsequent blocks against the canonical set
    for (let i = blocks.length - 1; i >= 1; i--) {
      const block = blocks[i][0];
      const symbols = extractExportSymbols(block);
      const novel = symbols.filter((s) => !canonicalSymbols.has(s));
      if (novel.length === 0) {
        out = out.replace(block, "");
      } else if (novel.length < symbols.length) {
        const cleaned = `export { ${novel.join(", ")} };`;
        out = out.replace(block, cleaned);
        for (const s of novel) canonicalSymbols.add(s);
      } else {
        for (const s of symbols) canonicalSymbols.add(s);
      }
    }
  }

  // 3. Clean up multiple consecutive blank lines left behind
  out = out.replace(/\n{3,}/g, "\n\n");

  return out;
}

/**
 * Walk `distDir` and patch every .js file in place. Returns the number of
 * files actually changed.
 */
export async function fixBunExports(distDir) {
  const files = await glob("**/*.js", { cwd: distDir });
  let totalFixed = 0;
  for (const rel of files) {
    const path = join(distDir, rel);
    const src = readFileSync(path, "utf-8");
    const out = patchSource(src);
    if (out !== src) {
      writeFileSync(path, out);
      totalFixed++;
      console.log(`  fixed: ${rel}`);
    }
  }
  return totalFixed;
}

// CLI entry — only runs when invoked directly, not when imported by tests.
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  const distDir = resolve(dirname(__filename), "..", "dist");
  const totalFixed = await fixBunExports(distDir);
  if (totalFixed > 0) {
    console.log(`fix-bun-exports: patched ${totalFixed} file(s)`);
  } else {
    console.log("fix-bun-exports: no issues found");
  }
}
