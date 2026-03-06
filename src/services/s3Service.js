"use strict";

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const config = require("../config");

const s3Client = new S3Client({
    region: config.aws.region,
    credentials: {
        accessKeyId: config.aws.accessKeyId,
        secretAccessKey: config.aws.secretAccessKey,
    },
});

/**
 * Upload a string body to S3.
 * @param {string} key         - S3 object key (path inside the bucket)
 * @param {string} body        - File content as a string
 * @param {string} contentType - MIME type (e.g. "application/json")
 */
async function uploadToS3(key, body, contentType) {
    const bucket = config.aws.bucketName;

    if (!bucket || bucket === "YOUR_BUCKET_NAME") {
        console.warn("⚠️  S3 upload skipped — bucket name not configured.");
        return null;
    }

    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
    });

    await s3Client.send(command);
    return `s3://${bucket}/${key}`;
}

module.exports = { uploadToS3 };
