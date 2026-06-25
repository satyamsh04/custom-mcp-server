import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { loadConfig } from "../config.js";

let client: S3Client | undefined;

// Memoized S3 client built from config. Tools import this so tests can mock
// the S3Client via aws-sdk-client-mock.
export function getS3Client(): S3Client {
  if (client === undefined) {
    const config = loadConfig();
    client = new S3Client({ region: config.awsRegion });
  }
  return client;
}

export { PutObjectCommand, GetObjectCommand };
