"use strict";

const cron = require("node-cron");
// const { runScraper } = require("../scrapers/bmsScraper");
const runScraper = async () => console.log("⚠️ [ScraperJob] bmsScraper is currently missing. Skipping.");
const { runTraktFetcher } = require("../scrapers/traktFetcher");
const { runTmdbFetcher } = require("../scrapers/tmdbFetcher");

/**
 * Starts the cron job that runs the BMS scraper every 6 hours.
 * Schedule: minute 0, every 6th hour  →  00:00, 06:00, 12:00, 18:00
 */
function startScraperJob() {
    cron.schedule("0 */6 * * *", async () => {
        console.log(`\n⏰ [ScraperJob] Triggered at ${new Date().toISOString()}`);
        try {
            console.log("\n[ScraperJob] Running Pre-Scrape Tasks (Trakt & TMDb)...");
            try {
                await runTraktFetcher();
                await runTmdbFetcher();
                console.log("[ScraperJob] Pre-Scrape Tasks Completed.");
            } catch (preErr) {
                console.error("[ScraperJob] Pre-Scrape Tasks Failed:", preErr.message);
            }
            
            await runScraper();
        } catch (err) {
            console.error("[ScraperJob] Run failed:", err.message);
        }
    });

    console.log("✅ Scraper job scheduled — runs every 6 hours (00:00 / 06:00 / 12:00 / 18:00)");
}

module.exports = { startScraperJob };
