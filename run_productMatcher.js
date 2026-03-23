"use strict";

/**
 * run_productMatcher.js
 *
 * CLI entry point for the product-event matching pipeline.
 *
 * Usage:
 *   node run_productMatcher.js --file products.xlsx
 *   node run_productMatcher.js --file products.xlsx --dry-run
 *
 * Options:
 *   --file <path>   Path to the .xlsx product file (required)
 *   --dry-run       Score & print matches but don't write anything
 */

process.chdir(__dirname);

const path = require("path");
const { runProductMatcher } = require("./productMatcher");

// ─── Parse CLI args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const fileIdx = args.indexOf("--file");
const dryRun = args.includes("--dry-run");

if (fileIdx === -1 || !args[fileIdx + 1]) {
  console.error("❌ Usage: node run_productMatcher.js --file products.xlsx [--dry-run]");
  process.exit(1);
}

const rawFilePath = args[fileIdx + 1];
const excelFilePath = path.isAbsolute(rawFilePath)
  ? rawFilePath
  : path.join(__dirname, rawFilePath);

// ─── Run ──────────────────────────────────────────────────────────────────────
runProductMatcher(excelFilePath, dryRun)
  .then(() => {
    if (!dryRun) {
      console.log(`Check product_event_matches.json for the full match summary.`);
    }
  })
  .catch((err) => {
    console.error("❌ Pipeline failed:", err.message);
    process.exit(1);
  });
