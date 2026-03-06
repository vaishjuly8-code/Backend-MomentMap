"use strict";

const puppeteer = require("puppeteer");
const fs = require("fs");
const { uploadToS3 } = require("../services/s3Service");

// ─── LISTING URLs ──────────────────────────────────────────────────────────────
const CATEGORIES = [
    { category: "Movies", emoji: "🎬", url: "https://in.bookmyshow.com/explore/movies-bengaluru" },
    { category: "Online Streams", emoji: "🎥", url: "https://in.bookmyshow.com/explore/c/stream" },
    { category: "Events", emoji: "🎪", url: "https://in.bookmyshow.com/explore/events-bengaluru" },
    { category: "Plays", emoji: "🎭", url: "https://in.bookmyshow.com/explore/plays-bengaluru" },
    { category: "Sports", emoji: "🏏", url: "https://in.bookmyshow.com/explore/sports-bengaluru" },
    { category: "Activities", emoji: "🧗", url: "https://in.bookmyshow.com/explore/activities-bengaluru" },
];

// ─── SELECTORS ────────────────────────────────────────────────────────────────
const LISTING = {
    cardLink: "a.sc-1ljcxl3-1",
    title: ".sc-7o7nez-0.beUxEp",
    meta: ".sc-7o7nez-0.bDUeYX",
};

const DETAIL = {
    title: "h1.sc-qswwm9-6.hxRESa",
    metaBlock: "div.sc-2k6tnd-0.gSHosf",
    description: "div.sc-o4g232-3.gseldT",
    interested: "div.sc-1h5m8q1-1.bjRuon",
    cast: "div.sc-tesakv-3.dpncct",
};

// ─── GEN Z SCORING ────────────────────────────────────────────────────────────
const GENZ_KEYWORDS = {
    "dj": 3, "edm": 3, "rave": 3, "techno": 3, "hiphop": 3, "hip hop": 3,
    "hip-hop": 3, "trap": 3, "k-pop": 3, "kpop": 3, "anime": 3, "cosplay": 3,
    "esports": 3, "gaming": 3, "hackathon": 3, "open mic": 3, "stand-up": 3,
    "standup": 3, "stand up": 3, "comedy": 3, "roast": 3, "drag": 3,
    "music festival": 2, "indie": 2, "underground": 2, "live music": 2,
    "fest": 2, "pop": 2, "rap": 2, "r&b": 2, "punk": 2, "rock": 2,
    "metal": 2, "electronic": 2, "college": 2, "student": 2, "youth": 2,
    "startup": 2, "workshop": 2, "spoken word": 2, "queer": 2, "party": 2,
    "club": 2, "outdoor": 2, "jam": 2, "battle": 2, "sci-fi": 2,
    "thriller": 1, "horror": 1, "action": 1, "fantasy": 1,
    "film": 1, "screening": 1, "stream": 1, "trending": 1,
};

const CATEGORY_BASE = {
    "Movies": 1, "Online Streams": 2, "Events": 2,
    "Plays": 0, "Sports": 1, "Activities": 2,
};

function getGenZScore(text, category) {
    const lower = (text || "").toLowerCase();
    let score = CATEGORY_BASE[category] || 0;
    for (const [kw, pts] of Object.entries(GENZ_KEYWORDS)) {
        if (lower.includes(kw)) score += pts;
    }
    return score;
}

function genZLabel(score) {
    if (score >= 6) return "🔥 Very High";
    if (score >= 4) return "✅ High";
    if (score >= 2) return "🟡 Moderate";
    return "⬜ Low";
}

// ─── PARSE META BLOCK ─────────────────────────────────────────────────────────
function parseMetaBlock(text) {
    if (!text) return {};
    const parts = text.split("•").map((s) => s.trim()).filter(Boolean);
    const result = { duration: null, genres: null, certification: null, date: null, language: null, format: null };

    for (const part of parts) {
        if (/^\d+h(\s\d+m)?$|^\d+m$/.test(part)) {
            result.duration = part;
        } else if (/^(U|UA|UA\d+\+|A)$/i.test(part)) {
            result.certification = part;
        } else if (/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{1,2}\/\d{1,2})\b/i.test(part)) {
            result.date = part;
        } else if (/^(2D|3D|IMAX|4DX|ICE|MX4D)$/i.test(part)) {
            result.format = part;
        } else if (/\b(Hindi|English|Kannada|Tamil|Telugu|Malayalam|Bengali|Marathi|Punjabi|Korean|Japanese|French)\b/i.test(part)) {
            result.language = part;
        } else if (part.length > 1 && part.length < 60) {
            result.genres = part;
        }
    }
    return result;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── BROWSER HELPERS ──────────────────────────────────────────────────────────
async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let total = 0;
            const timer = setInterval(() => {
                window.scrollBy(0, 500);
                total += 500;
                if (total >= document.body.scrollHeight - window.innerHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 250);
        });
    });
    await sleep(1500);
}

async function dismissCityPopup(page) {
    try {
        await page.evaluate(() => {
            const all = [...document.querySelectorAll("li, button, a, div, span, p")];
            const t = all.find((el) => {
                const txt = el.innerText?.trim().toLowerCase();
                return txt === "bengaluru" || txt === "bangalore";
            });
            if (t) t.click();
        });
        await sleep(800);
    } catch (_) { }
}

// ─── PHASE 1: COLLECT LINKS ───────────────────────────────────────────────────
async function getLinks(page, cat) {
    console.log(`\n  ${cat.emoji}  Collecting links: ${cat.category}`);
    try {
        await page.goto(cat.url, { waitUntil: "networkidle2", timeout: 45000 });
    } catch (e) {
        console.warn(`     ⚠️  Failed: ${e.message}`);
        return [];
    }

    await sleep(2500);
    await dismissCityPopup(page);
    await autoScroll(page);

    const links = await page.evaluate((LISTING) => {
        let cards = [...document.querySelectorAll(LISTING.cardLink)];
        if (cards.length === 0) {
            cards = [...document.querySelectorAll("a[href]")].filter((a) =>
                /\/(movies|events|plays|sports|activities|stream)\//i.test(a.href) &&
                a.innerText?.trim().length > 3
            );
        }
        return cards
            .map((a) => ({
                link: a.href,
                quickTitle:
                    a.querySelector(".sc-7o7nez-0.beUxEp")?.innerText?.trim() ||
                    a.querySelector("h3")?.innerText?.trim() || "",
                image: a.querySelector("img")?.src || a.querySelector("img")?.dataset?.src || null,
            }))
            .filter((item) => item.link && item.link.startsWith("http"));
    }, LISTING);

    const seen = new Set();
    const unique = links.filter((l) => {
        if (seen.has(l.link)) return false;
        seen.add(l.link);
        return true;
    });

    console.log(`     🔗 ${unique.length} links found`);
    return unique;
}

// ─── PHASE 2: SCRAPE DETAIL PAGE ──────────────────────────────────────────────
async function scrapeDetail(page, linkObj) {
    try {
        await page.goto(linkObj.link, { waitUntil: "networkidle2", timeout: 30000 });
        await sleep(1500);
    } catch (e) {
        return { title: linkObj.quickTitle, link: linkObj.link, image: linkObj.image, error: e.message };
    }

    return await page.evaluate((DETAIL, linkObj) => {
        const clean = (sel) =>
            document.querySelector(sel)?.innerText?.trim().replace(/\s+/g, " ") || null;

        const title = clean(DETAIL.title) || linkObj.quickTitle || document.title?.split("|")[0]?.trim();
        const metaRaw = clean(DETAIL.metaBlock);
        const description = clean(DETAIL.description);
        const interested = clean(DETAIL.interested);

        const castBlocks = [...document.querySelectorAll(DETAIL.cast)];
        const cast = castBlocks[0] ? castBlocks[0].innerText.trim().replace(/\s+/g, " ") : null;
        const crew = castBlocks[1] ? castBlocks[1].innerText.trim().replace(/\s+/g, " ") : null;

        const img =
            document.querySelector("section img, [class*='poster'] img, [class*='banner'] img, img")?.src ||
            linkObj.image;

        return { title, metaRaw, description, interested, cast, crew, image: img, link: window.location.href };
    }, DETAIL, linkObj);
}

// ─── MAIN EXPORTED FUNCTION ───────────────────────────────────────────────────
async function runScraper() {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  🎟️  BookMyShow Bengaluru — Full Detail Scraper");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--window-size=1366,900",
            ],
            defaultViewport: { width: 1366, height: 900 },
        });

        const page = await browser.newPage();

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        );
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, "webdriver", { get: () => false });
        });

        const cdp = await page.target().createCDPSession();
        await cdp.send("Emulation.setGeolocationOverride", {
            latitude: 12.9716, longitude: 77.5946, accuracy: 100,
        });

        await page.setRequestInterception(true);
        page.on("request", (req) => {
            if (req.resourceType() === "font") req.abort();
            else req.continue();
        });

        // ── Phase 1 ──────────────────────────────────────────────────────────────
        console.log("📋 PHASE 1 — Collecting event links from listing pages...");
        const allLinks = [];
        for (const cat of CATEGORIES) {
            const links = await getLinks(page, cat);
            for (const l of links) allLinks.push({ ...l, category: cat.category, emoji: cat.emoji });
            await sleep(1500);
        }
        console.log(`\n✅ Total links collected: ${allLinks.length}`);

        // ── Phase 2 ──────────────────────────────────────────────────────────────
        console.log("\n🔍 PHASE 2 — Scraping full details from each page...\n");
        const allItems = [];

        for (let i = 0; i < allLinks.length; i++) {
            const linkObj = allLinks[i];
            process.stdout.write(
                `  [${String(i + 1).padStart(3)}/${allLinks.length}] ${linkObj.emoji} ${linkObj.quickTitle?.slice(0, 45) || linkObj.link.slice(-30)}...`
            );

            const detail = await scrapeDetail(page, linkObj);
            const meta = parseMetaBlock(detail.metaRaw);

            const scoreText = [detail.title, meta.genres, detail.description, meta.language, linkObj.category].join(" ");
            const genZScore = getGenZScore(scoreText, linkObj.category);

            allItems.push({
                category: linkObj.category,
                emoji: linkObj.emoji,
                city: "Bengaluru",
                title: detail.title || linkObj.quickTitle,
                date: meta.date || null,
                duration: meta.duration || null,
                genres: meta.genres || null,
                certification: meta.certification || null,
                language: meta.language || null,
                format: meta.format || null,
                description: detail.description || null,
                cast: detail.cast || null,
                crew: detail.crew || null,
                interested: detail.interested || null,
                image: detail.image || linkObj.image || null,
                link: detail.link || linkObj.link,
                genZScore,
                genZRelevance: genZLabel(genZScore),
            });

            console.log(` ✓ (GenZ: ${genZScore})`);
            await sleep(800);
        }

        // ── Sort & Group ─────────────────────────────────────────────────────────
        const sorted = [...allItems].sort((a, b) => b.genZScore - a.genZScore);
        const genZItems = sorted.filter((e) => e.genZScore >= 2);
        const byCategory = {};
        for (const item of sorted) {
            if (!byCategory[item.category]) byCategory[item.category] = [];
            byCategory[item.category].push(item);
        }

        // ── Build output ─────────────────────────────────────────────────────────
        const output = {
            meta: {
                source: "BookMyShow",
                city: "Bengaluru",
                scrapedAt: new Date().toISOString(),
                totalItems: sorted.length,
                genZRelevantCount: genZItems.length,
                countByCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.length])),
            },
            genZHighlights: genZItems,
            byCategory,
        };

        const jsonString = JSON.stringify(output, null, 2);

        const q = (v) => `"${(v || "").toString().replace(/"/g, "'").replace(/\n/g, " ")}"`;
        const csvString = [
            ["Emoji", "Category", "Title", "Date", "Duration", "Genres", "Certification", "Language", "Format", "Description", "Cast", "Interested", "Gen Z Score", "Gen Z Relevance", "Link"].join(","),
            ...sorted.map((e) => [
                e.emoji, q(e.category), q(e.title),
                q(e.date || ""), q(e.duration || ""), q(e.genres || ""),
                q(e.certification || ""), q(e.language || ""), q(e.format || ""),
                q(e.description || ""), q(e.cast || ""), q(e.interested || ""),
                e.genZScore, q(e.genZRelevance), q(e.link || ""),
            ].join(","))
        ].join("\n");

        // ── Save locally ──────────────────────────────────────────────────────────
        fs.writeFileSync("bms_bengaluru.json", jsonString);
        fs.writeFileSync("bms_bengaluru.csv", csvString);

        // ── Upload to S3 ──────────────────────────────────────────────────────────
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const jsonKey = `bms_bengaluru/data_${timestamp}.json`;
        const csvKey = `bms_bengaluru/data_${timestamp}.csv`;

        console.log("\n☁️  Uploading to S3...");
        try {
            const jsonUrl = await uploadToS3(jsonKey, jsonString, "application/json");
            const csvUrl = await uploadToS3(csvKey, csvString, "text/csv");
            if (jsonUrl) console.log(`✅ JSON → ${jsonUrl}`);
            if (csvUrl) console.log(`✅ CSV  → ${csvUrl}`);
        } catch (err) {
            console.error("❌ S3 upload failed:", err.message);
        }

        // ── Summary ───────────────────────────────────────────────────────────────
        console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log(`  ✅ SCRAPE COMPLETE | Items: ${sorted.length} | Gen Z: ${genZItems.length}`);
        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

        return output;

    } finally {
        if (browser) await browser.close().catch(console.error);
    }
}

module.exports = { runScraper };
