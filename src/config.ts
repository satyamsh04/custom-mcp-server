import "dotenv/config";
import { z } from "zod";

export interface AppConfig {
  awsRegion: string;
  s3Bucket: string;
  dynamoTable: string;
  slackBotToken: string;
  slackDefaultChannel: string;
  oauthIssuer: string;
  oauthAudience: string;
  jwksUri: string;
  jwtSecret?: string;
  rateLimitPerMin: number;
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  logLevel: string;
}

const numericWithDefault = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const envSchema = z.object({
  AWS_REGION: z.string().min(1, "AWS_REGION is required"),
  S3_BUCKET_NAME: z.string().min(1, "S3_BUCKET_NAME is required"),
  DYNAMO_TABLE_NAME: z.string().min(1, "DYNAMO_TABLE_NAME is required"),
  SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required"),
  SLACK_DEFAULT_CHANNEL: z.string().min(1, "SLACK_DEFAULT_CHANNEL is required"),
  OAUTH_ISSUER: z.string().min(1, "OAUTH_ISSUER is required"),
  OAUTH_AUDIENCE: z.string().min(1, "OAUTH_AUDIENCE is required"),
  JWKS_URI: z.string().min(1, "JWKS_URI is required"),
  JWT_SECRET: z.string().optional(),
  RATE_LIMIT_PER_MIN: numericWithDefault(100),
  RETRY_MAX_ATTEMPTS: numericWithDefault(3),
  RETRY_BASE_DELAY_MS: numericWithDefault(200),
  LOG_LEVEL: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? "info" : v)),
});

// Memoized per env object reference so handlers don't re-parse process.env on
// every tool invocation. Tests that mutate the environment can call
// resetConfigCache() to force a fresh parse.
let cache: { env: NodeJS.ProcessEnv; config: AppConfig } | undefined;

export function resetConfigCache(): void {
  cache = undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cache !== undefined && cache.env === env) {
    return cache.config;
  }

  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${missing}`);
  }

  const e = parsed.data;
  const config: AppConfig = {
    awsRegion: e.AWS_REGION,
    s3Bucket: e.S3_BUCKET_NAME,
    dynamoTable: e.DYNAMO_TABLE_NAME,
    slackBotToken: e.SLACK_BOT_TOKEN,
    slackDefaultChannel: e.SLACK_DEFAULT_CHANNEL,
    oauthIssuer: e.OAUTH_ISSUER,
    oauthAudience: e.OAUTH_AUDIENCE,
    jwksUri: e.JWKS_URI,
    jwtSecret: e.JWT_SECRET,
    rateLimitPerMin: e.RATE_LIMIT_PER_MIN,
    retryMaxAttempts: e.RETRY_MAX_ATTEMPTS,
    retryBaseDelayMs: e.RETRY_BASE_DELAY_MS,
    logLevel: e.LOG_LEVEL,
  };

  cache = { env, config };
  return config;
}
