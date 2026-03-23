"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config");
const { getObjectFromS3 } = require("./s3Service");

let cachedProducts = null;

// ─────────────────────────────────────────────
// FIELD WEIGHTS
// Higher = more important for matching
// ─────────────────────────────────────────────
const FIELD_WEIGHTS = {
    color: 4,
    occasion: 4,
    ethnicity: 4,
    pattern: 3,
    activity: 3,
    fit: 3,
    style: 3,
    theme: 2,
    material: 2,
    detail: 2,
    neckline: 2,
    length: 2,
    transparency: 1,
    hemline_style: 1,
    size_group: 1,
};

// ─────────────────────────────────────────────
// SEMANTIC SYNONYMS
// If product value is in group, and event has 
// any value in same group → partial score
// ─────────────────────────────────────────────
const SEMANTIC_GROUPS = {
    color: [
        ["red", "maroon", "burgundy", "crimson", "scarlet", "ruby", "wine", "deep-red"],
        ["pink", "blush", "dusty-rose", "fuchsia", "hot-pink", "magenta", "rose-pink"],
        ["orange", "rust", "burnt-orange", "tangerine", "saffron", "marigold"],
        ["yellow", "mustard", "gold", "turmeric", "caramel"],
        ["green", "dark-green", "olive", "sage", "teal", "emerald-green", "forest-green", "lime-green", "bottle-green"],
        ["blue", "navy", "indigo", "cobalt", "royal-blue", "sapphire", "deep-blue", "sky-blue", "powder-blue"],
        ["purple", "lavender", "violet", "deep-plum", "lilac"],
        ["white", "off-white", "cream", "ivory", "pearl-white", "champagne"],
        ["grey", "charcoal-grey", "light-grey", "slate-grey", "silver"],
        ["brown", "tan", "beige", "khaki", "caramel", "mocha", "toffee", "light-brown"],
        ["black", "charcoal"],
        ["multi", "multicolor"],
    ],
    pattern: [
        ["floral", "botanical", "leaf-print", "flower"],
        ["geometric", "abstract", "diagonal-stripes", "horizontal-stripes", "vertical-stripes", "checks", "gingham", "mini-checks"],
        ["embroidered", "embellished", "sequins", "shimmer", "lace", "cut-work"],
        ["ethnic-motif", "printed", "statement-print", "abstract"],
        ["solid", "self-design"],
    ],
    fit: [
        ["relaxed", "loose", "oversized", "baggy"],
        ["slim", "skinny", "slim-fit", "skinny-fit"],
        ["regular", "regular-fit"],
    ],
    style: [
        ["over-sized", "baggy", "boxy", "loose-fit"],
        ["slim-fit", "skinny-fit", "tailored", "sheath"],
        ["wide-leg", "flared", "bell-bottom", "trapeze"],
        ["straight-fit", "regular-fit", "a-line"],
        ["cargo", "relaxed"],
    ],
    material: [
        ["cotton", "100%-cotton", "cotton-blend", "cotton-poly-blend", "cotton-lycra-blend", "cotton-rayon-blend", "cotton-viscose-blend", "cotton-linen-blend", "cotton-tencel-blend"],
        ["rayon", "viscose-rayon", "100%-rayon"],
        ["linen", "linen-blend"],
        ["polyester", "100%-polyester", "poly-blend"],
        ["nylon", "nylon-elastane", "polyamide-spandex"],
        ["satin", "silk-feel", "georgette-feel", "chiffon-feel"],
        ["leather", "synthetic"],
        ["spandex-blend", "elastane"],
    ],
    occasion: [
        ["party", "elevated", "special"],
        ["casual", "basic-casual"],
        ["festive", "holiday"],
        ["workwear", "everyday-work", "formal-work"],
        ["athletic", "athleisure"],
    ],
    activity: [
        ["festive", "holiday", "dance-and-costumes"],
        ["concert", "clubbing", "day-and-night"],
        ["brunch", "cocktail", "dinner-and-ceremonies"],
        ["athleisure", "walking", "leisure-sport"],
        ["travel", "beach-and-resort"],
        ["loungewear", "sleepwear"],
    ],
    theme: [
        ["traditional", "spiritual", "classic"],
        ["trendy", "contemporary", "fashion"],
        ["bohemian", "nature", "dainty"],
        ["designer", "novelty"],
    ],
    neckline: [
        ["v-neck", "keyhole", "cowl"],
        ["round", "crew", "scoop"],
        ["halter", "spaghetti-straps", "one-shoulder", "off-shoulder"],
        ["square", "sweetheart", "straight"],
        ["turtleneck", "mock", "high-neck"],
        ["mandarin", "camp", "polo", "button-down"],
        ["hooded", "half-zip"],
    ],
    length: [
        ["above-waist", "waist", "crop-length"],
        ["hip", "below-hip"],
        ["mid-thigh", "upper-thigh", "above-knee"],
        ["knee", "below-knee"],
        ["mid-calf", "above-ankle", "ankle"],
        ["floor", "full"],
    ],
};

// ─────────────────────────────────────────────
// LOAD PRODUCT CATALOG
// ─────────────────────────────────────────────
async function loadProductCatalog() {
    if (cachedProducts) return cachedProducts;

    const catalogPath = config.pipeline.productCatalogPath;
    let content = "";
    let isJson = catalogPath.endsWith(".json");

    try {
        if (catalogPath.startsWith("s3://")) {
            const key = catalogPath.replace(/^s3:\/\/[^\/]+\//, "");
            content = await getObjectFromS3(key);
            isJson = key.endsWith(".json");
        } else {
            const fullPath = path.isAbsolute(catalogPath)
                ? catalogPath
                : path.join(process.cwd(), catalogPath);

            if (fs.existsSync(fullPath)) {
                content = fs.readFileSync(fullPath, "utf-8");
            } else {
                console.warn(`⚠️  Product catalog not found at ${fullPath}. Using empty catalog.`);
                return [];
            }
        }

        if (!content) return [];

        let rawProducts = [];
        if (isJson) {
            rawProducts = JSON.parse(content);
        } else {
            const lines = content.trim().split("\n");
            const headers = lines[0].split("\t").map(h => h.trim());
            rawProducts = lines.slice(1).map(line => {
                const cols = line.split("\t");
                const obj = {};
                headers.forEach((h, i) => {
                    obj[h] = cols[i] ? cols[i].trim() : "";
                });
                return obj;
            });
        }

        // Normalize all keys (e.g. "Style Code" -> "style_code", "Department" -> "department")
        cachedProducts = rawProducts.map(p => {
            const normalized = {};
            for (const [key, val] of Object.entries(p)) {
                const cleanKey = key.trim().toLowerCase().replace(/\s+/g, "_");
                normalized[cleanKey] = val;
            }
            // Ensure compatibility mappings
            if (normalized.department && !normalized.gender) normalized.gender = normalized.department;
            if (normalized.gender && !normalized.department) normalized.department = normalized.gender;
            
            return normalized;
        });

        console.log(`📦 Loaded ${cachedProducts.length} products (normalized). Source: ${isJson ? "JSON" : "TSV"}`);
        return cachedProducts;

    } catch (err) {
        console.error("❌ Failed to load product catalog:", err.message);
        return [];
    }
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

/**
 * Splits a product field value into an array of clean tokens.
 * Handles comma-separated, pipe-separated, or single values.
 */
function parseProductValues(raw) {
    if (!raw) return [];
    return raw
        .toLowerCase()
        .split(/[,|;]+/)
        .map(v => v.trim())
        .filter(Boolean);
}

/**
 * Normalizes event keyword values to lowercase array.
 */
function parseEventValues(val) {
    if (!val || val === "not-needed") return [];
    if (Array.isArray(val)) return val.map(v => v.toLowerCase().trim()).filter(Boolean);
    if (typeof val === "string") return [val.toLowerCase().trim()];
    return [];
}

/**
 * Finds semantic group index for a given value in a field.
 * Returns -1 if not found.
 */
function getSemanticGroupIndex(field, value) {
    const groups = SEMANTIC_GROUPS[field];
    if (!groups) return -1;
    return groups.findIndex(group => group.includes(value));
}

/**
 * Checks if two values are semantically related (same group).
 */
function areSemanticallyRelated(field, valA, valB) {
    const groupA = getSemanticGroupIndex(field, valA);
    if (groupA === -1) return false;
    const groupB = getSemanticGroupIndex(field, valB);
    return groupA === groupB;
}

/**
 * Scores a single field match between product values and event keyword values.
 * Returns:
 *   weight * 1.0  → exact match
 *   weight * 0.4  → semantic/synonym match
 *   0             → no match
 */
function scoreField(field, productValues, eventValues, weight) {
    if (!productValues.length || !eventValues.length) return 0;

    let bestScore = 0;

    for (const pVal of productValues) {
        for (const eVal of eventValues) {
            if (pVal === eVal) {
                // Exact match — full weight
                bestScore = Math.max(bestScore, weight * 1.0);
            } else if (areSemanticallyRelated(field, pVal, eVal)) {
                // Semantic match — partial weight
                bestScore = Math.max(bestScore, weight * 0.4);
            }
        }
    }

    return bestScore;
}

// ─────────────────────────────────────────────
// HARD FILTER
// Returns false if product should be excluded
// ─────────────────────────────────────────────
function passesHardFilters(product, kw) {
    const department = parseEventValues(kw.department);
    const preferred = (kw.preferred_categories || []).map(c => c.toLowerCase().trim());
    const avoid = (kw.avoid_categories || []).map(c => c.toLowerCase().trim());

    const pGender = (product.gender || "").toLowerCase().trim();
    const pCat = (product.category || "").toLowerCase().trim();

    // 1. Gender/department filter
    if (
        department.length > 0 &&
        pGender &&
        !department.includes(pGender) &&
        pGender !== "unisex"
    ) {
        return false;
    }

    // 2. Must be in preferred categories
    if (preferred.length > 0 && pCat && !preferred.some(c => pCat.includes(c) || c.includes(pCat))) {
        return false;
    }

    // 3. Must not be in avoid categories
    if (avoid.some(c => pCat.includes(c) || c.includes(pCat))) {
        return false;
    }

    return true;
}

// ─────────────────────────────────────────────
// BONUS SCORES
// Event-specific logic for extra signal
// ─────────────────────────────────────────────
function getBonusScore(product, kw) {
    let bonus = 0;

    const pCat = (product.category || "").toLowerCase();
    const ethnicity = parseEventValues(kw.ethnicity);
    const preferredCats = (kw.preferred_categories || []).map(c => c.toLowerCase());

    // Bonus: ethnicity alignment
    // If event is ethnic and product category is ethnic → reward
    if (ethnicity.includes("ethnic")) {
        const ethnicCategories = ["saree", "kurta", "kurti", "lehenga", "ethnic", "salwar", "dhoti", "sherwani", "anarkali", "sharara", "chaniya"];
        if (ethnicCategories.some(e => pCat.includes(e))) {
            bonus += 3;
        }
    }

    // Bonus: western event and western product category
    if (ethnicity.includes("western") && !ethnicity.includes("ethnic")) {
        const westernCategories = ["t-shirt", "shirt", "top", "dress", "jeans", "trouser", "shorts", "skirt", "jumpsuit", "co-ord", "sweatshirt", "jacket"];
        if (westernCategories.some(w => pCat.includes(w))) {
            bonus += 2;
        }
    }

    // Bonus: exact preferred category match (not just partial)
    if (preferredCats.some(c => c === pCat)) {
        bonus += 2;
    }

    // Bonus: jewellery fields — if event has jewellery_pattern and product is jewellery
    const jewelleryPattern = parseEventValues(kw.jewellery_pattern);
    const pendantsType = parseEventValues(kw.pendants_type);
    const jewelleryCategories = ["necklace", "earring", "bracelet", "ring", "anklet", "jewellery"];

    if (jewelleryCategories.some(j => pCat.includes(j))) {
        const pJewelleryPattern = parseProductValues(product.jewellery_pattern || product.pattern);
        const pPendantType = parseProductValues(product.pendant_type || product.pendants_type);

        if (jewelleryPattern.length && pJewelleryPattern.length) {
            bonus += scoreField("pattern", pJewelleryPattern, jewelleryPattern, 2);
        }
        if (pendantsType.length && pPendantType.length) {
            bonus += scoreField("pattern", pPendantType, pendantsType, 2);
        }
    }

    // Bonus: surface_styling match for ethnic/elevated events
    const surfaceStyling = parseEventValues(kw.surface_styling);
    const pSurface = parseProductValues(product.surface_styling || product.fabric_finish);
    if (surfaceStyling.length && pSurface.length) {
        bonus += scoreField("pattern", pSurface, surfaceStyling, 2);
    }

    // Bonus: treatment/distress for denim products
    const treatment = parseEventValues(kw.treatment);
    const distress = parseEventValues(kw.distress);
    const pTreatment = parseProductValues(product.treatment || product.wash);
    const pDistress = parseProductValues(product.distress);

    if (treatment.length && pTreatment.length) {
        bonus += scoreField("pattern", pTreatment, treatment, 1);
    }
    if (distress.length && pDistress.length) {
        bonus += scoreField("pattern", pDistress, distress, 1);
    }

    // Bonus: color_2 / accent color match
    const color2 = parseEventValues(kw.color_2);
    const pColor2 = parseProductValues(product.color_2 || product.accent_color);
    if (color2.length && pColor2.length) {
        bonus += scoreField("color", pColor2, color2, 2);
    }

    return bonus;
}

// ─────────────────────────────────────────────
// MAIN MATCH FUNCTION
// ─────────────────────────────────────────────
async function matchProducts(event) {
    const products = await loadProductCatalog();
    if (!products.length) return [];

    const kw = event.fashion_keywords;
    if (!kw) return [];

    const scored = [];

    for (const product of products) {

        // Step 1: Hard filters
        if (!passesHardFilters(product, kw)) continue;

        // Step 2: Soft scoring across weighted fields
        let score = 0;

        for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
            const productValues = parseProductValues(product[field]);
            const eventValues = parseEventValues(kw[field]);
            score += scoreField(field, productValues, eventValues, weight);
        }

        // Step 3: Bonus scoring
        score += getBonusScore(product, kw);

        // Step 4: Only include products with meaningful score
        if (score > 0) {
            scored.push({
                style_code: product.style_code,
                score: Math.round(score * 100) / 100, // round to 2dp
                category: product.category,
                gender: product.gender,
            });
        }
    }

    // Step 5: Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Step 6: Optional debug logging
    if (config.pipeline.debugScoring) {
        console.log(`\n🎯 Top matches for "${event.title}":`);
        scored.slice(0, 10).forEach((p, i) => {
            console.log(`  ${i + 1}. ${p.style_code} | ${p.category} | ${p.gender} | score: ${p.score}`);
        });
    }

    // Step 7: Return top N style codes
    return scored
        .slice(0, config.pipeline.topNProducts)
        .map(p => p.style_code);
}

// ─────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────
module.exports = { loadProductCatalog, matchProducts };