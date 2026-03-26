"use strict";

/**
 * productMatcher.js
 *
 * Standalone pipeline:
 *   1. Parse Excel (.xlsx) → products JSON
 *   2. Load all YYYY-MM/DD.json day files from S3
 *   3. Score every product against every event (using unified productService)
 *   4. MERGE matched style_codes into event.products (de-duped, never removes)
 *   5. Re-upload updated day files to S3
 */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { uploadToS3, listObjectsInS3, getObjectFromS3 } = require("./src/services/s3Service");
const config = require("./src/config");
const { matchProducts } = require("./src/services/productService");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const LOCAL_OUTPUT_FILE = path.join(__dirname, "product_event_matches.json");

// ─── STEP 1: PARSE EXCEL ──────────────────────────────────────────────────────

/**
 * Parses an .xlsx source into cleaned product objects.
 */
function parseExcel(filePathOrBuffer, fileName = "upload") {
  let buffer;
  let label;

  if (typeof filePathOrBuffer === "string") {
    if (!fs.existsSync(filePathOrBuffer)) {
      throw new Error(`Excel file not found: ${filePathOrBuffer}`);
    }
    buffer = fs.readFileSync(filePathOrBuffer);
    label  = path.basename(filePathOrBuffer);
  } else {
    buffer = Buffer.isBuffer(filePathOrBuffer) ? filePathOrBuffer : Buffer.from(filePathOrBuffer);
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

async function loadAllMonthlyFilesFromS3() {
  const monthFilePattern = /^\d{4}-\d{2}\.json$/;
  const allObjects = await listObjectsInS3("");
  const monthKeys = (allObjects || []).map((o) => o.Key).filter((k) => monthFilePattern.test(k));

  if (monthKeys.length === 0) {
    console.warn("⚠️  No YYYY-MM.json files found in S3.");
    return new Map();
  }

  const monthFileMap = new Map();
  for (const key of monthKeys) {
    try {
      const content = await getObjectFromS3(key);
      if (!content) continue;
      monthFileMap.set(key, { data: JSON.parse(content), dirty: false });
    } catch (e) {
      console.warn(`   ⚠️  Skipped ${key}: ${e.message}`);
    }
  }
  return monthFileMap;
}

// ─── STEP 2.5: MANAGE PRODUCT CATALOG IN S3 ──────────────────────────────────

async function loadExistingCatalog() {
  const catalogPath = config.pipeline.productCatalogPath;
  if (!catalogPath) return [];

  const key = catalogPath.startsWith("s3://") ? catalogPath.replace(/^s3:\/\/[^\/]+\//, "") : catalogPath;
  let keyToLoad = key;
  if (key.endsWith(".tsv")) {
    const jsonKey = key.replace(".tsv", ".json");
    const exists = await getObjectFromS3(jsonKey);
    if (exists) keyToLoad = jsonKey;
  }

  const content = await getObjectFromS3(keyToLoad);
  if (!content) return [];

  try {
    if (keyToLoad.endsWith(".json")) return JSON.parse(content);
    if (keyToLoad.endsWith(".tsv")) {
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
    return [];
  }
}

async function saveCatalogToS3(products) {
  let key = config.pipeline.productCatalogPath || "products.json";
  if (key.startsWith("s3://")) key = key.replace(/^s3:\/\/[^\/]+\//, "");
  if (key.endsWith(".tsv")) key = key.replace(".tsv", ".json");
  await uploadToS3(key, JSON.stringify(products, null, 2), "application/json");
}

// ─── STEP 3: MATCH + MERGE + UPLOAD ──────────────────────────────────────

async function matchAndMerge(products, monthFileMap, dryRun = false) {
  const allEvents = [];
  for (const [monthKey, { data }] of monthFileMap) {
    // data is { "DD": { "events": [...], "last_updated": "..." } }
    for (const [dayKey, dayObj] of Object.entries(data)) {
      for (const event of (dayObj.events || [])) {
        if (event.id) allEvents.push({ monthKey, dayKey, event });
      }
    }
  }

  const totalEvents   = allEvents.length;
  const matchSummary  = {};
  let   totalMatches  = 0;
  let   eventsUpdated = 0;

  console.log(`\n🔗 Re-matching ${totalEvents} events using unified service logic...`);

  for (const { monthKey, dayKey, event } of allEvents) {
    const oldProducts = new Set(event.products || []);
    const newMatches = await matchProducts(event);
    const merged = new Set([...oldProducts, ...newMatches]);
    
    if (merged.size > oldProducts.size) {
        const added = [...merged].filter(code => !oldProducts.has(code));
        event.products = [...merged];
        monthFileMap.get(monthKey).dirty = true;
        matchSummary[event.id] = added;
        totalMatches += added.length;
        eventsUpdated++;
    }
  }

  const output = {
    generated_at: new Date().toISOString(),
    dry_run: dryRun,
    events_in_s3: totalEvents,
    new_links_added: totalMatches,
    events_with_new_products: eventsUpdated,
    matches: matchSummary,
  };

  if (!dryRun) {
    fs.writeFileSync(LOCAL_OUTPUT_FILE, JSON.stringify(output, null, 2), "utf-8");
    const dirtyFiles = [...monthFileMap.entries()].filter(([, v]) => v.dirty);
    for (const [monthKey, { data }] of dirtyFiles) {
      await uploadToS3(monthKey, JSON.stringify(data, null, 2), "application/json");
      console.log(`   ✅ Updated month file: ${monthKey}`);
    }
  }

  return output;
}

async function _run(newProducts, dryRun) {
  const existingCatalog = await loadExistingCatalog();
  const catalogMap = new Map();
  [...existingCatalog, ...newProducts].forEach(p => {
    const code = p.style_code || p["style code"];
    if (code) catalogMap.set(String(code).toLowerCase(), p);
  });
  const updatedCatalog = Array.from(catalogMap.values());
  if (!dryRun) await saveCatalogToS3(updatedCatalog);
  const monthFileMap = await loadAllMonthlyFilesFromS3();
  return matchAndMerge(updatedCatalog, monthFileMap, dryRun);
}

async function runProductMatcher(excelFilePath, dryRun = false) {
  const products = parseExcel(excelFilePath);
  return _run(products, dryRun);
}

async function runProductMatcherFromBuffer(buffer, fileName = "upload.xlsx", dryRun = false) {
  const products = parseExcel(buffer, fileName);
  return _run(products, dryRun);
}

module.exports = {
  runProductMatcher,
  runProductMatcherFromBuffer,
  parseExcel,
};
