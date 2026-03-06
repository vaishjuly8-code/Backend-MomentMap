"use strict";

require("dotenv").config();

module.exports = {
    port: process.env.PORT || 3001,

    aws: {
        region: process.env.AWS_REGION || "ap-south-1",
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
        bucketName: process.env.S3_BUCKET_NAME || "",
    },
};
