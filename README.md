# custom-mcp-server

A production [Model Context Protocol](https://modelcontextprotocol.io) server for a
data-annotation workflow. It exposes six tools over the MCP stdio transport,
backed by AWS S3 + DynamoDB and Slack, with JWT auth, per-tool rate limiting,
and exponential-backoff retries.

## Prerequisites

- Node.js 20 LTS
- npm
- AWS account (S3 bucket + DynamoDB table) and a Slack bot token for runtime use
  (not required to run the test suite — all external calls are mocked)

## Install

```bash
npm install
```

## Environment setup

Copy `.env.example` to `.env` and fill in the values. Keys:

| Key | Required by | Notes |
|---|---|---|
| `AWS_REGION` | all AWS tools | e.g. `us-east-1` |
| `AWS_ACCESS_KEY_ID` | all AWS tools | secret — keep out of source control |
| `AWS_SECRET_ACCESS_KEY` | all AWS tools | secret |
| `S3_BUCKET_NAME` | `s3_upload`, `s3_download` | default bucket |
| `DYNAMO_TABLE_NAME` | `dynamo_read/write`, `annotation_status` | table with partition key `id` |
| `SLACK_BOT_TOKEN` | `slack_notify`, `annotation_status` | secret, `xoxb-...` |
| `SLACK_DEFAULT_CHANNEL` | `slack_notify`, `annotation_status` | e.g. `#annotations` |
| `OAUTH_ISSUER` | auth (every call) | expected `iss` claim |
| `OAUTH_AUDIENCE` | auth (every call) | expected `aud` claim |
| `JWKS_URI` | auth (RS256) | JWKS endpoint for signature verification |
| `JWT_SECRET` | auth (HS256 fallback) | optional, dev/local only |
| `RATE_LIMIT_PER_MIN` | rate limiter | default `100` |
| `RETRY_MAX_ATTEMPTS` | retry | default `3` |
| `RETRY_BASE_DELAY_MS` | retry | default `200` |
| `LOG_LEVEL` | logger | `debug`/`info`/`warn`/`error`, default `info` |

## Build / test / run

```bash
npm run build       # compile TypeScript to dist/
npm run typecheck   # tsc --noEmit
npm test            # Jest (ESM) — all external calls mocked
npm start           # node dist/server.js (stdio transport)
```

## Tools

| Tool | Input (required**) | Behavior |
|---|---|---|
| `s3_upload` | `key`**, `contentBase64`**, `contentType?`, `bucket?` | Upload base64 content to S3; returns `{ bucket, key, etag }` |
| `s3_download` | `key`**, `bucket?` | Download object; returns `{ bucket, key, contentBase64, contentType }` |
| `dynamo_read` | `id`**, `consistentRead?` | Read record by `id`; returns the item or `{ found: false }` |
| `dynamo_write` | `id`**, `attributes`**, `overwrite?` | Put record; `overwrite:false` fails on conflict |
| `slack_notify` | `message`**, `channel?`, `threadTs?` | Post to Slack; returns `{ channel, ts }` |
| `annotation_status` | `taskId`**, `newStatus?`, `notify?` | Read/update task status, optionally notify Slack |

## Auth model

Every tool call is authenticated. The caller supplies a JWT (via the request
`_meta.authorization` field, optionally `Bearer`-prefixed). The server verifies
the signature (RS256 against `JWKS_URI`, or HS256 via `JWT_SECRET` for local
dev), checks `iss`/`aud`/expiry, and derives an `AuthContext` (`subject`,
`scopes`). Invalid tokens are rejected with `AUTH_INVALID`.

## Rate limiting & retries

- **Rate limit:** 100 requests/min per tool (configurable), in-memory per
  process. Exceeding it yields `RATE_LIMITED`.
- **Retry:** transient failures (`retryable: true`) are retried up to 3 times
  with exponential backoff (`baseDelay * 2^(n-1)`). Conflicts, validation, and
  auth errors are never retried.
- **Idempotency note:** retries wrap non-idempotent writes (`dynamo_write`,
  `slack_notify`). Only transient errors are retried, but adding idempotency
  keys is recommended future work.

## Cursor setup

`.cursor/mcp.json` registers the server with Cursor:

```json
{
  "mcpServers": {
    "custom-mcp-server": {
      "command": "node",
      "args": ["dist/server.js"],
      "env": { "AWS_REGION": "us-east-1", "...": "..." }
    }
  }
}
```

Secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SLACK_BOT_TOKEN`,
`JWT_SECRET`) are **not** placed in `mcp.json`; provide them via your shell
environment / `.env`. Run `npm run build` before launching so `dist/server.js`
exists.

## Architecture

See [`PLAN.md`](./PLAN.md) for the full milestone plan, interface contracts, and
blocker analysis. Source layout:

```
src/
  server.ts            stdio transport + tool-call pipeline
  config.ts            env loading + validation (zod)
  types.ts             shared interface contracts
  errors.ts            AppError exception + guards
  logger.ts            stderr-only structured logger
  auth/oauth.ts        JWT validation
  middleware/          retry.ts, rate-limiter.ts
  clients/             s3/dynamo/slack factories
  tools/               one file per tool + index.ts
```
