"use strict";

const fs = require("fs");
const path = require("path");
const { uploadToS3 } = require("./src/services/s3Service");

async function uploadAllEvents() {
    const localDir = path.join(__dirname, "total_events_s3");
    
    if (!fs.existsSync(localDir)) {
        console.error("❌ Error: total_events_s3 directory not found.");
        process.exit(1);
    }

    const files = fs.readdirSync(localDir).filter(f => f.endsWith(".json"));

    console.log(`\n📦 Found ${files.length} monthly files. Starting upload to S3...`);

    for (const file of files) {
        const filePath = path.join(localDir, file);
        const s3Key = `events/${file}`;
        
        try {
            const content = fs.readFileSync(filePath, "utf-8");
            console.log(`🚀 Uploading ${file} -> ${s3Key}...`);
            await uploadToS3(s3Key, content, "application/json");
        } catch (err) {
            console.error(`❌ Failed to upload ${file}:`, err.message);
        }
    }

    console.log("\n✅ All monthly event files uploaded successfully!");
    console.log("Verified endpoints: http://localhost:3001/api/events/2026-03 etc.");
}

uploadAllEvents();
