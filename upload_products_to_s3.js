"use strict";

const fs = require("fs");
const path = require("path");
const { uploadToS3 } = require("./src/services/s3Service");

async function uploadProducts() {
    const localPath = path.join(__dirname, "products_static.json");
    const s3Key = "products/total_products.json";

    console.log(`\n📦 Reading local products from: ${localPath}`);
    
    if (!fs.existsSync(localPath)) {
        console.error("❌ Error: products_static.json not found in the root directory.");
        process.exit(1);
    }

    try {
        const fileContent = fs.readFileSync(localPath, "utf-8");
        const products = JSON.parse(fileContent);

        console.log(`🚀 Uploading ${products.length} products to S3: ${s3Key}...`);
        
        const result = await uploadToS3(s3Key, fileContent, "application/json");

        if (result) {
            console.log(`✅ Success! Catalog uploaded to: ${result}`);
            console.log("\nYou can now hit http://localhost:3001/api/products to verify.");
        } else {
            console.error("❌ Upload failed. Check your S3_BUCKET_NAME in .env.");
        }
    } catch (err) {
        console.error("❌ Failed to upload products:", err.message);
    }
}

uploadProducts();
