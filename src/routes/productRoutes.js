"use strict";

const express = require("express");
const router = express.Router();
const { getObjectFromS3 } = require("../services/s3Service");

/**
 * GET /api/products
 * Returns the total product catalog JSON from S3.
 */
router.get("/", async (req, res) => {
    try {
        const s3Key = "products/total_products.json";
        console.log(`📂 [ProductsAPI] Fetching ${s3Key} from S3...`);
        
        const data = await getObjectFromS3(s3Key);

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "Product catalog not found in S3."
            });
        }

        const products = JSON.parse(data);
        return res.json({
            success: true,
            count: Array.isArray(products) ? products.length : 1,
            data: products
        });
    } catch (err) {
        console.error("❌ [ProductsAPI] Error fetching catalog:", err.message);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch product catalog from S3.",
            error: err.message
        });
    }
});

module.exports = router;
