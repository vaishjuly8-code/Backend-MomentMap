"use strict";

/**
 * productMatcher.js
 *
 * Standalone pipeline:
 *   1. Parse Excel (.xlsx) → products JSON
 *   2. Load all YYYY-MM/DD.json day files from S3
 *   3. Score every product against every event (fashion_keywords matching)
 *   4. MERGE matched style_codes into event.products (de-duped, never removes)
 *   5. Re-upload updated day files to S3
 *   6. Always write product_event_matches.json locally
 *
 * Usage (via run_productMatcher.js):
 *   node run_productMatcher.js --file products.xlsx [--dry-run]
 */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { uploadToS3, listObjectsInS3, getObjectFromS3 } = require("./src/services/s3Service");
const config = require("./src/config");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const LOCAL_OUTPUT_FILE = path.join(__dirname, "product_event_matches.json");
const MIN_SCORE = 1; // minimum soft score for a product to match an event

// Fields used in soft scoring — must match keys in fashion_keywords AND product row
const SCORE_FIELDS = [
  "color", "fit", "style", "pattern",
  "material", "neckline", "occasion",
  "detail", "transparency",
];

// ─── STEP 1: PARSE EXCEL ──────────────────────────────────────────────────────

/**
 * Parses an .xlsx source into cleaned product objects.
 * Accepts either:
 *   - a file path string  (used by CLI run_productMatcher.js)
 *   - a Buffer / ArrayBuffer (used by the POST API route)
 * Column headers are normalized: "Style Code" → "style_code"
 */
function parseExcel(filePathOrBuffer, fileName = "upload") {
  let buffer;
  let label;

  if (typeof filePathOrBuffer === "string") {
    // File path
    if (!fs.existsSync(filePathOrBuffer)) {
      throw new Error(`Excel file not found: ${filePathOrBuffer}`);
    }
    buffer = fs.readFileSync(filePathOrBuffer);
    label  = path.basename(filePathOrBuffer);
  } else {
    // Buffer / ArrayBuffer from an upload
    buffer = Buffer.isBuffer(filePathOrBuffer)
      ? filePathOrBuffer
      : Buffer.from(filePathOrBuffer);
    label  = fileName;
  }

  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const rawRows  = XLSX.utils.sheet_to_json(sheet);

  const products = rawRows.map((row) => {
    const cleaned = {};
    for (const [key, val] of Object.entries(row)) {
      const cleanKey = key.trim().toLowerCase().replace(/\s+/g, "_");
      cleaned[cleanKey] = val !== undefined && val !== null ? String(val).trim() : null;
    }
    return cleaned;
  });

  console.log(`📦 Parsed ${products.length} products from ${label}`);
  return products;
}

// ─── STEP 2: LOAD DAY FILES FROM S3 ──────────────────────────────────────────

/**
 * Lists all YYYY-MM/DD.json keys in the bucket and loads each one.
 * Returns a map: key → { parsed dayData object, dirty: false }
 */
async function loadAllDayFilesFromS3() {
  const dayFilePattern = /^\d{4}-\d{2}\/\d{2}\.json$/;

  console.log("☁️  Listing S3 day files...");
  const allObjects = await listObjectsInS3(""); // list everything
  const dayKeys = (allObjects || [])
    .map((o) => o.Key)
    .filter((k) => dayFilePattern.test(k));

  if (dayKeys.length === 0) {
    console.warn("⚠️  No YYYY-MM/DD.json files found in S3. Run the BMS scraper first.");
    return new Map();
  }

  console.log(`   Found ${dayKeys.length} day files. Loading...`);
  const dayFileMap = new Map(); // key → { data: {...}, dirty: false }

  for (const key of dayKeys) {
    try {
      const content = await getObjectFromS3(key);
      if (!content) continue;
      const data = JSON.parse(content);
      dayFileMap.set(key, { data, dirty: false });
    } catch (e) {
      console.warn(`   ⚠️  Skipped ${key}: ${e.message}`);
    }
  }

  console.log(`   ✅ Loaded ${dayFileMap.size} day files`);
  return dayFileMap;
}

// ─── STEP 2.5: MANAGE PRODUCT CATALOG IN S3 ──────────────────────────────────

/**
 * Loads the existing product catalog from S3.
 * Supports JSON or TSV (fallback).
 */
async function loadExistingCatalog() {
  const catalogPath = config.pipeline.productCatalogPath;
  if (!catalogPath) return [];

  // Extract key if it's an s3:// URL, otherwise assume it's just the key
  const key = catalogPath.startsWith("s3://")
    ? catalogPath.replace(/^s3:\/\/[^\/]+\//, "")
    : catalogPath;

  // If config says .tsv, check if a .json version exists first (migration)
  let keyToLoad = key;
  if (key.endsWith(".tsv")) {
    const jsonKey = key.replace(".tsv", ".json");
    const exists = await getObjectFromS3(jsonKey);
    if (exists) {
      keyToLoad = jsonKey;
      console.log(`   (Migrating: Found .json catalog in S3, using that instead of .tsv)`);
    }
  }

  console.log(`☁️  Loading existing catalog from S3: ${keyToLoad}`);
  const content = await getObjectFromS3(keyToLoad);
  if (!content) {
    console.warn("⚠️  Catalog not found in S3. Starting fresh.");
    return [];
  }

  try {
    if (keyToLoad.endsWith(".json")) {
      return JSON.parse(content);
    } else if (keyToLoad.endsWith(".tsv")) {
      const lines = content.trim().split("\n");
      const headers = lines[0].split("\t").map(h => h.trim());
      return lines.slice(1).map(line => {
        const cols = line.split("\t");
        const obj = {};
        headers.forEach((h, i) => {
          const cleanKey = h.toLowerCase().replace(/\s+/g, "_");
          obj[cleanKey] = cols[i] ? cols[i].trim() : "";
        });
        return obj;
      });
    }
    return [];
  } catch (e) {
    console.error(`❌ Failed to parse existing catalog: ${e.message}`);
    return [];
  }
}

/**
 * Saves the updated product catalog back to S3 as JSON.
 */
async function saveCatalogToS3(products) {
  let key = config.pipeline.productCatalogPath || "products.json";
  if (key.startsWith("s3://")) {
    key = key.replace(/^s3:\/\/[^\/]+\//, "");
  }
  
  // Force .json for the updated catalog if it was .tsv
  if (key.endsWith(".tsv")) {
    key = key.replace(".tsv", ".json");
  }

  console.log(`☁️  Uploading updated catalog to S3: ${key}`);
  await uploadToS3(key, JSON.stringify(products, null, 2), "application/json");
}

// ─── STEP 3: SCORING ──────────────────────────────────────────────────────────

/**
 * Scores a single product against a single event's fashion_keywords.
 * Returns { passes: boolean, score: number }
 * 
 * Hard filters (must pass both):
 *   - product.gender must appear in event.fashion_keywords.department
 *   - product.category must be in preferred_categories and NOT in avoid_categories
 *
 * Soft score (+1 per matching field from SCORE_FIELDS).
 */
function scoreProductAgainstEvent(product, event) {
  const kw = event.fashion_keywords;
  if (!kw) return { passes: false, score: 0 };

  // Normalise keyword arrays
  const department = (kw.department || []).map((d) => d.toLowerCase());
  const preferred  = (kw.preferred_categories || []).map((c) => c.toLowerCase());
  const avoid      = (kw.avoid_categories || []).map((c) => c.toLowerCase());

  const pGender = (product.gender || "").toLowerCase();
  const pCat    = (product.category || "").toLowerCase();

  // ── Hard filter 1: gender / department
  if (
    department.length > 0 &&
    pGender &&
    !department.includes(pGender) &&
    pGender !== "unisex"
  ) {
    return { passes: false, score: 0 };
  }

  // ── Hard filter 2: category
  if (preferred.length > 0 && pCat && !preferred.some((p) => pCat.includes(p) || p.includes(pCat))) {
    return { passes: false, score: 0 };
  }
  if (avoid.some((a) => pCat.includes(a) || a.includes(pCat))) {
    return { passes: false, score: 0 };
  }

  // ── Soft score
  let score = 0;
  for (const field of SCORE_FIELDS) {
    const pVal   = (product[field] || "").toLowerCase();
    const kwVals = (kw[field] || []).map((v) => v.toLowerCase());
    if (pVal && kwVals.includes(pVal)) score++;
  }

  return { passes: score >= MIN_SCORE, score };
}

// ─── STEP 4 & 5: MATCH + MERGE + UPLOAD ──────────────────────────────────────

/**
 * Main matching pass.
 * For every product × every event: score it. If it passes, merge style_code
 * into the event's products array (de-duped, never removes existing codes).
 *
 * @param {Array}  products   - cleaned product rows from Excel
 * @param {Map}    dayFileMap - key → { data, dirty }
 * @param {boolean} dryRun   - if true, skip all writes
 * @returns {Object} summary
 */
async function matchAndMerge(products, dayFileMap, dryRun = false) {
  // Build a flat index: event_id → { dayKey, eventRef }
  const eventIndex = new Map();
  for (const [dayKey, { data }] of dayFileMap) {
    for (const event of (data.events || [])) {
      if (event.id) {
        eventIndex.set(event.id, { dayKey, event });
      }
    }
  }

  const totalEvents   = eventIndex.size;
  const matchSummary  = {}; // event_id → [style_codes added this run]
  let   totalMatches  = 0;
  let   eventsUpdated = 0;

  console.log(`\n🔗 Matching ${products.length} products against ${totalEvents} events...`);

  for (const product of products) {
    const styleCode = product.style_code || product["style code"] || null;
    if (!styleCode) continue; // skip rows without a style code

    for (const [eventId, { dayKey, event }] of eventIndex) {
      const { passes } = scoreProductAgainstEvent(product, event);
      if (!passes) continue;

      // Merge into event.products (de-duped Set)
      const existing = new Set(event.products || []);
      if (!existing.has(styleCode)) {
        existing.add(styleCode);
        event.products = [...existing];

        // Mark day file dirty so it gets re-uploaded
        const entry = dayFileMap.get(dayKey);
        if (!entry.dirty) {
          entry.dirty = true;
          eventsUpdated++;
        }

        // Track for summary
        if (!matchSummary[eventId]) matchSummary[eventId] = [];
        matchSummary[eventId].push(styleCode);
        totalMatches++;
      }
    }
  }

  console.log(`   ✅ ${totalMatches} new product-event links across ${Object.keys(matchSummary).length} events`);

  // ── Write local summary
  const output = {
    generated_at:     new Date().toISOString(),
    dry_run:          dryRun,
    products_in_file: products.length,
    events_in_s3:     totalEvents,
    new_links_added:  totalMatches,
    events_with_new_products: Object.keys(matchSummary).length,
    matches: matchSummary,
  };

  if (!dryRun) {
    fs.writeFileSync(LOCAL_OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");
    console.log(`\n📄 Local summary → ${path.basename(LOCAL_OUTPUT_FILE)}`);
  } else {
    console.log("\n🔵 DRY RUN — no files written.");
    console.log(JSON.stringify(output, null, 2));
    return output;
  }

  // ── Re-upload dirty day files to S3
  const dirtyFiles = [...dayFileMap.entries()].filter(([, v]) => v.dirty);
  console.log(`\n☁️  Uploading ${dirtyFiles.length} modified day files to S3...`);

  for (const [dayKey, { data }] of dirtyFiles) {
    data.last_updated = new Date().toISOString();
    await uploadToS3(dayKey, JSON.stringify(data, null, 2), "application/json");
    console.log(`   ✅ Uploaded: ${dayKey}`);
  }

  return output;
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────

/**
 * Internal runner shared by both entry points.
 */
async function _run(newProducts, dryRun) {
  // 1. Load existing catalog
  const existingCatalog = await loadExistingCatalog();
  
  // 2. Merge new products into catalog (de-dupe by style_code)
  const catalogMap = new Map();
  existingCatalog.forEach(p => {
    const code = p.style_code || p["style code"];
    if (code) catalogMap.set(String(code).toLowerCase(), p);
  });
  
  newProducts.forEach(p => {
    const code = p.style_code || p["style code"];
    if (code) catalogMap.set(String(code).toLowerCase(), p);
  });
  
  const updatedCatalog = Array.from(catalogMap.values());
  
  if (!dryRun) {
    await saveCatalogToS3(updatedCatalog);
  }

  // 3. Load S3 day files
  const dayFileMap = await loadAllDayFilesFromS3();
  if (dayFileMap.size === 0 && !dryRun) {
    throw new Error("No events found in S3. Run the BMS scraper first.");
  }

  // 4. Match the FULL updated catalog against events
  return matchAndMerge(updatedCatalog, dayFileMap, dryRun);
}

/**
 * Entry point for CLI: run_productMatcher.js
 * @param {string}  excelFilePath - absolute path to .xlsx file
 * @param {boolean} dryRun
 */
async function runProductMatcher(excelFilePath, dryRun = false) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  🛍️  MomentMap — Product-Event Matching Pipeline");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Step 1 — Parse Excel from path
  const products = parseExcel(excelFilePath);

  const summary = await _run(products, dryRun);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  ✅ DONE | ${summary.new_links_added} new product-event links added`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

/**
 * Entry point for the POST API route.
 * @param {Buffer|ArrayBuffer} buffer   - raw bytes from file.arrayBuffer()
 * @param {string}             fileName - original filename (for logging)
 * @param {boolean}            dryRun
 */
async function runProductMatcherFromBuffer(buffer, fileName = "upload.xlsx", dryRun = false) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  🛍️  MomentMap — Product-Event Matching Pipeline (Upload)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const products = parseExcel(buffer, fileName);
  const summary  = await _run(products, dryRun);

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  ✅ DONE | ${summary.new_links_added} new product-event links added`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  return summary;
}

module.exports = {
  runProductMatcher,
  runProductMatcherFromBuffer,
  parseExcel,
  scoreProductAgainstEvent,
};
