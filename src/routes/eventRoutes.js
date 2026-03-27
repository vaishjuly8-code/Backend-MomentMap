"use strict";

const express = require("express");
const router = express.Router();
const { getObjectFromS3 } = require("../services/s3Service");

/**
 * GET /api/events/:month
 * Returns the consolidated monthly events for the given year-month (e.g. 2026-03).
 */
router.get("/:month", async (req, res) => {
    const { month } = req.params; // Format: YYYY-MM

    try {
        const s3Key = `events/${month}.json`;
        console.log(`📂 [EventsAPI] Fetching ${s3Key} from S3...`);
        
        const data = await getObjectFromS3(s3Key);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: `Events for month "${month}" not found in S3.`
            });
        }

        const events = JSON.parse(data);
        return res.json({
            success: true,
            month,
            data: events
        });
    } catch (err) {
        console.error(`❌ [EventsAPI] Error fetching ${month}:`, err.message);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch event data from S3.",
            error: err.message
        });
    }
});

module.exports = router;
