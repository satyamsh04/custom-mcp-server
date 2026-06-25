// Sets all required env vars so loadConfig() succeeds inside tool handlers.
// No real credentials — AWS/Slack calls are mocked in tests.
export function setTestEnv(): void {
  process.env.AWS_REGION = "us-east-1";
  process.env.S3_BUCKET_NAME = "annotation-artifacts";
  process.env.DYNAMO_TABLE_NAME = "annotation-records";
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  process.env.SLACK_DEFAULT_CHANNEL = "#annotations";
  process.env.OAUTH_ISSUER = "https://auth.example.com/";
  process.env.OAUTH_AUDIENCE = "custom-mcp-server";
  process.env.JWKS_URI = "https://auth.example.com/jwks.json";
}
