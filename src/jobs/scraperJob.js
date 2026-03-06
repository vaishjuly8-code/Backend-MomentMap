"use strict";

const cron = require("node-cron");
const { runScraper } = require("../scrapers/bmsScraper");

/**
 * Starts the cron job that runs the BMS scraper every 6 hours.
 * Schedule: minute 0, every 6th hour  →  00:00, 06:00, 12:00, 18:00
 */
function startScraperJob() {
    cron.schedule("0 */6 * * *", async () => {
        console.log(`\n⏰ [ScraperJob] Triggered at ${new Date().toISOString()}`);
        try {
            await runScraper();
        } catch (err) {
            console.error("[ScraperJob] Run failed:", err.message);
        }
    });

    console.log("✅ Scraper job scheduled — runs every 6 hours (00:00 / 06:00 / 12:00 / 18:00)");
}

module.exports = { startScraperJob };
