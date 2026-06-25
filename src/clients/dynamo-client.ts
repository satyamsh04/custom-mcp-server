import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { loadConfig } from "../config.js";

let docClient: DynamoDBDocumentClient | undefined;

// Memoized DynamoDB DocumentClient. Tools import this so tests can mock it
// via aws-sdk-client-mock.
export function getDynamoClient(): DynamoDBDocumentClient {
  if (docClient === undefined) {
    const config = loadConfig();
    const base = new DynamoDBClient({ region: config.awsRegion });
    docClient = DynamoDBDocumentClient.from(base);
  }
  return docClient;
}

export { GetCommand, PutCommand, UpdateCommand };
