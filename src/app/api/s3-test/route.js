import { NextResponse } from "next/server";
const { getObjectFromS3, listObjectsInS3 } = require("../../../services/s3Service");
const config = require("../../../config");

/**
 * GET /api/s3-test?key=some-file.json
 * If key is provided, returns the content of the file.
 * If no key is provided, lists the objects in the S3 bucket.
 */
export async function GET(request) {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get("key");

    try {
        const bucket = config.aws.bucketName;

        if (!bucket || bucket === "YOUR_BUCKET_NAME_HERE") {
            return NextResponse.json({
                success: false,
                message: "S3_BUCKET_NAME is not configured in .env",
                currentBucket: bucket
            }, { status: 400 });
        }

        if (key) {
            console.log(`🔍 Testing S3 GET for: ${key}`);
            const data = await getObjectFromS3(key);

            if (!data) {
                return NextResponse.json({
                    success: false,
                    message: `File "${key}" not found or empty (Check if you uploaded it).`
                }, { status: 404 });
            }

            return NextResponse.json({
                success: true,
                message: `Successfully fetched "${key}"`,
                data: JSON.parse(data).length || "Object fetched (not an array)",
                preview: data.substring(0, 100) + "..."
            });
        } else {
            console.log("🔍 Testing S3 LIST...");
            const objects = await listObjectsInS3("");

            return NextResponse.json({
                success: true,
                message: `Connected to bucket "${bucket}"`,
                objectCount: objects.length,
                objects: objects.map(o => o.Key).slice(0, 10)
            });
        }
    } catch (error) {
        console.error("❌ S3 Test Failed:", error.message);
        return NextResponse.json({
            success: false,
            message: error.message
        }, { status: 500 });
    }
}
